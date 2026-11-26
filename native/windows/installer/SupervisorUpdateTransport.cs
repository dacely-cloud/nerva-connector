// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

/// <summary>Uses the installed Node TLS stack without giving the child signature or installation authority.</summary>
internal static class NexaConnectorSupervisorUpdateTransport
{
    /// <summary>Streams one bounded HTTPS response into a new staging file and validates the finite transport receipt.</summary>
    internal static void Fetch(
        string directory,
        Uri address,
        string destination,
        long maximum,
        int timeout,
        string stage,
        NexaConnectorSupervisorLog log
    )
    {
        if (
            address.Scheme != "https"
            || address.UserInfo.Length != 0
            || address.Query.Length != 0
            || address.Fragment.Length != 0
            || maximum < 1
            || maximum > NexaConnectorUpdateFeed.MaximumSetupBytes
            || timeout < 1
            || timeout > 600000
            || !(stage == "manifest" || stage == "signature" || stage == "installer")
        )
            throw Failed(stage, "INPUT_INVALID");
        if (File.Exists(destination))
            throw Failed(stage, "DESTINATION_EXISTS");
        string node = Path.Combine(directory, "node.exe");
        string application = Path.Combine(directory, "nerva-connector.mjs");
        if (!File.Exists(node) || !File.Exists(application))
            throw Failed(stage, "RUNTIME_MISSING");
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = node;
        start.Arguments = "\"" + application + "\" --windows-update-fetch";
        start.WorkingDirectory = directory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.StandardOutputEncoding = Encoding.UTF8;
        start.StandardErrorEncoding = Encoding.UTF8;
        foreach (string name in new string[] { "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS" })
            start.EnvironmentVariables.Remove(name);
        start.EnvironmentVariables["NODE_TLS_REJECT_UNAUTHORIZED"] = "1";
        bool verified = false;
        bool started = false;
        using (Process child = new Process())
        {
            child.StartInfo = start;
            Capture output = null;
            Capture error = null;
            try
            {
                try
                {
                    if (!child.Start())
                        throw Failed(stage, "START_FAILED");
                    started = true;
                }
                catch (System.ComponentModel.Win32Exception)
                {
                    throw Failed(stage, "START_FAILED");
                }
                output = new Capture(child, child.StandardOutput);
                error = new Capture(child, child.StandardError);
                Dictionary<string, object> request = new Dictionary<string, object>();
                request.Add("address", address.AbsoluteUri);
                request.Add("destination", Path.GetFullPath(destination));
                request.Add("maximumBytes", maximum.ToString(CultureInfo.InvariantCulture));
                request.Add("timeoutMs", timeout);
                byte[] input = Encoding.UTF8.GetBytes(
                    new JavaScriptSerializer().Serialize(request) + "\n"
                );
                child.StandardInput.BaseStream.Write(input, 0, input.Length);
                child.StandardInput.BaseStream.Flush();
                child.StandardInput.Close();
                if (!child.WaitForExit(timeout + 5000))
                    throw Failed(stage, "PROCESS_TIMEOUT");
                if (!output.Join() || !error.Join())
                    throw Failed(stage, "OUTPUT_TIMEOUT");
                if (output.Failed || error.Failed)
                    throw Failed(stage, "OUTPUT_LIMIT");
                if (child.ExitCode != 0)
                {
                    Match code = Regex.Match(
                        error.Text.Trim(),
                        @"\Awindows-update-fetch code=([A-Z0-9_]{1,64})\z"
                    );
                    throw Failed(stage, code.Success ? code.Groups[1].Value : "CHILD_FAILED");
                }
                Dictionary<string, object> receipt = null;
                try
                {
                    JavaScriptSerializer serializer = new JavaScriptSerializer();
                    serializer.MaxJsonLength = 8192;
                    serializer.RecursionLimit = 4;
                    receipt =
                        serializer.DeserializeObject(output.Text) as Dictionary<string, object>;
                }
                catch (ArgumentException)
                {
                    throw Failed(stage, "RECEIPT_INVALID");
                }
                catch (InvalidOperationException)
                {
                    throw Failed(stage, "RECEIPT_INVALID");
                }
                object protocol;
                object count;
                long bytes;
                if (
                    error.Text.Trim().Length != 0
                    || receipt == null
                    || receipt.Count != 2
                    || !receipt.TryGetValue("protocol", out protocol)
                    || !(protocol is string)
                    || (string)protocol != "TLSv1.3"
                    || !receipt.TryGetValue("bytes", out count)
                    || !(count is string)
                    || !Regex.IsMatch((string)count, @"\A(0|[1-9][0-9]{0,8})\z")
                    || !long.TryParse(
                        (string)count,
                        NumberStyles.None,
                        CultureInfo.InvariantCulture,
                        out bytes
                    )
                    || bytes > maximum
                    || !File.Exists(destination)
                    || new FileInfo(destination).Length != bytes
                )
                    throw Failed(stage, "RECEIPT_INVALID");
                verified = true;
                log.Write(
                    "update fetch stage="
                        + stage
                        + " protocol=TLSv1.3 bytes="
                        + bytes.ToString(CultureInfo.InvariantCulture)
                );
            }
            finally
            {
                try
                {
                    if (started)
                    {
                        try
                        {
                            if (!child.HasExited)
                            {
                                child.Kill();
                                if (!child.WaitForExit(5000))
                                    throw Failed(stage, "SHUTDOWN_UNCONFIRMED");
                            }
                        }
                        finally
                        {
                            if (output != null)
                                output.Join();
                            if (error != null)
                                error.Join();
                        }
                    }
                }
                finally
                {
                    if (!verified && File.Exists(destination))
                        File.Delete(destination);
                }
            }
        }
    }

    /// <summary>Only a known stage and finite code enter the existing supervisor exception log.</summary>
    private static InvalidDataException Failed(string stage, string code)
    {
        return new InvalidDataException(
            "update fetch stage=" + stage + " code=" + code + " tls-min=TLSv1.3"
        );
    }

    /// <summary>Both child pipes drain concurrently with finite storage, so a failed helper cannot block the updater.</summary>
    private sealed class Capture
    {
        private readonly Thread thread;
        private readonly StringBuilder text = new StringBuilder();
        internal bool Failed;

        internal Capture(Process child, StreamReader input)
        {
            thread = new Thread(
                delegate()
                {
                    try
                    {
                        char[] buffer = new char[1024];
                        int read;
                        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            if (text.Length + read > 8192)
                            {
                                Failed = true;
                                try
                                {
                                    child.Kill();
                                }
                                catch (InvalidOperationException) { }
                                catch (System.ComponentModel.Win32Exception) { }
                                return;
                            }
                            text.Append(buffer, 0, read);
                        }
                    }
                    catch (IOException)
                    {
                        Failed = true;
                    }
                    catch (ObjectDisposedException)
                    {
                        Failed = true;
                    }
                }
            );
            thread.IsBackground = true;
            thread.Start();
        }

        internal string Text
        {
            get { return text.ToString(); }
        }

        internal bool Join()
        {
            return thread.Join(5000);
        }
    }
}
