// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

/// <summary>An authenticated host-user broker retains its job after root exit; it is deliberately not a sandbox.</summary>
public static class NexaConnectorHostProcess
{
    public static int Main(string[] arguments)
    {
        if (arguments.Length == 1 && arguments[0] == "--desktop") return NexaConnectorHostDesktop.Run();
        if (arguments.Length > 0 && (arguments[0] == "--terminal" || arguments[0] == "--terminal-probe")) return NexaConnectorHostTerminal.Run(arguments);
        if (arguments.Length != 3 || arguments[0].Length > 30000 || !arguments[1].StartsWith("\\\\.\\pipe\\nerva-connector-host-", StringComparison.Ordinal) || arguments[2].Length != 36) return 70;
        try
        {
            using (NamedPipeClientStream channel = new NamedPipeClientStream(".", arguments[1].Substring(9), PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                channel.Connect(10000);
                Send(channel, new Dictionary<string, object> { { "token", arguments[2] }, { "kind", "ready" } });
                StreamReader reader = new StreamReader(channel, new UTF8Encoding(false, true), false, 256, true);
                if (ReadControl(reader, arguments[2]) != "start") return 70;
                using (HostControl control = new HostControl(reader, arguments[2]))
                using (HostLaunch launch = new HostLaunch())
                {
                    bool failed = false, stopAfterFailure = false, rejected = false;
                    Exception launchError = null;
                    try
                    {
                        launch.Start(arguments[0], control.Cancellation);
                        Send(channel, new Dictionary<string, object> { { "token", arguments[2] }, { "kind", "started" } });
                    }
                    catch (Exception error) { failed = true; stopAfterFailure = true; launchError = error; }
                    bool reported = false, reportedOutput = false, rootUnavailable = false;
                    bool? reportedTree = null;
                    while (true)
                    {
                        if (control.TakeStop() || stopAfterFailure)
                        {
                            stopAfterFailure = false;
                            try
                            {
                                launch.StopAndJoin();
                                if (launch.RootCreated) launch.WaitOutput(1000);
                            }
                            catch (NexaConnectorHostJobUnconfirmedException)
                            {
                                if (control.Disconnected) Environment.Exit(74);
                                Send(channel, new Dictionary<string, object> { { "token", arguments[2] }, { "kind", "stop-failed" } });
                                control.Wait(100);
                                continue;
                            }
                        }
                        uint rootExit;
                        bool exited;
                        try { exited = launch.TryRootExit(out rootExit); rootUnavailable = false; }
                        catch (NexaConnectorHostJobUnconfirmedException)
                        {
                            if (control.Disconnected) Environment.Exit(74);
                            if (!rootUnavailable) Send(channel, new Dictionary<string, object> { { "token", arguments[2] }, { "kind", "stop-failed" } });
                            rootUnavailable = true;
                            control.Wait(100);
                            continue;
                        }
                        if (exited || (failed && !launch.RootCreated))
                        {
                            bool? tree = null;
                            try { tree = launch.TreeRunning; }
                            catch (NexaConnectorHostJobUnconfirmedException) { }
                            bool complete = launch.OutputComplete || !launch.RootCreated;
                            if (!rejected && failed && !launch.RootCreated && tree == false)
                            {
                                Send(channel, Rejection(arguments[2], launchError));
                                rejected = true;
                            }
                            if (!reported || tree != reportedTree || (complete && !reportedOutput))
                            {
                                Report(channel, arguments[2], exited ? (long?)rootExit : null, failed, tree, complete ? (long?)launch.StdoutBytes : null, complete ? (long?)launch.StderrBytes : null);
                                reported = true; reportedTree = tree; reportedOutput = complete;
                            }
                            if (tree == false && (complete || control.Stopping || failed)) return failed ? 70 : 0;
                        }
                        if (control.Disconnected) Environment.Exit(74);
                        control.Wait(100);
                    }
                }
            }
        }
        catch { return 70; }
    }

    /// <summary>This frame is emitted only after the caller proves no root was created and the owned job is empty.</summary>
    internal static Dictionary<string, object> Rejection(string token, Exception error)
    {
        NexaConnectorHostCreateException create = error as NexaConnectorHostCreateException;
        return new Dictionary<string, object> {
            { "token", token }, { "kind", "launch-rejected" },
            { "errorCode", create != null ? create.ErrorCode : error is OperationCanceledException ? "canceled" : "operation-failed" },
            { "nativeError", create != null ? (object)create.NativeError : null }
        };
    }

    private static void Send(Stream channel, Dictionary<string, object> value)
    {
        byte[] report = new UTF8Encoding(false, true).GetBytes(new JavaScriptSerializer().Serialize(value) + "\n");
        if (report.Length > 1024) throw new InvalidOperationException("host-report-limit");
        channel.Write(report, 0, report.Length);
        channel.Flush();
    }

    private static void Report(Stream channel, string token, long? exit, bool failed, bool? tree, long? stdout, long? stderr)
    {
        Send(channel, new Dictionary<string, object> {
            { "token", token }, { "kind", "report" }, { "exitCode", exit }, { "signal", null },
            { "launchFailed", failed }, { "treeRunning", tree },
            { "stdoutFinalBytes", stdout.HasValue ? stdout.Value.ToString(CultureInfo.InvariantCulture) : null },
            { "stderrFinalBytes", stderr.HasValue ? stderr.Value.ToString(CultureInfo.InvariantCulture) : null }
        });
    }

    private static string ReadControl(TextReader reader, string token)
    {
        StringBuilder line = new StringBuilder();
        while (line.Length <= 256)
        {
            int value = reader.Read();
            if (value < 0) throw new EndOfStreamException();
            if (value == 10)
            {
                JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 256, RecursionLimit = 2 };
                Dictionary<string, object> control = json.Deserialize<Dictionary<string, object>>(line.ToString());
                if (control == null || control.Count != 2 || !control.ContainsKey("token") || !control.ContainsKey("operation") || !(control["token"] is string) || (string)control["token"] != token || !(control["operation"] is string)) throw new InvalidOperationException("host-control-invalid");
                return (string)control["operation"];
            }
            line.Append((char)value);
        }
        throw new InvalidOperationException("host-control-limit");
    }

    private sealed class HostControl : IDisposable
    {
        private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        private readonly AutoResetEvent wake = new AutoResetEvent(false);
        private int requested;
        internal volatile bool Disconnected;
        internal bool Stopping { get { return cancellation.IsCancellationRequested; } }
        internal CancellationToken Cancellation { get { return cancellation.Token; } }
        internal HostControl(TextReader reader, string token)
        {
            Thread monitor = new Thread(delegate() {
                try { while (true) { if (ReadControl(reader, token) != "stop") throw new InvalidOperationException("host-control-operation"); Signal(); } }
                catch { Disconnected = true; Signal(); }
            });
            monitor.IsBackground = true;
            monitor.Start();
        }
        private void Signal() { Interlocked.Exchange(ref requested, 1); try { cancellation.Cancel(); wake.Set(); } catch (ObjectDisposedException) { } }
        internal bool TakeStop() { return Interlocked.Exchange(ref requested, 0) != 0; }
        internal void Wait(int milliseconds) { wake.WaitOne(milliseconds); }
        public void Dispose() { cancellation.Dispose(); wake.Dispose(); }
    }

    private sealed class HostOutputPump : IDisposable
    {
        private readonly FileStream reader;
        private readonly Stream destination;
        private readonly ManualResetEvent done = new ManualResetEvent(false);
        private Thread thread;
        internal long Bytes;
        private bool complete;
        internal bool Complete { get { return done.WaitOne(0) && complete; } }
        internal HostOutputPump(SafeFileHandle handle, Stream output) { reader = new FileStream(handle, FileAccess.Read, 65536, false); destination = output; }
        internal void Start() { thread = new Thread(Copy); thread.IsBackground = true; thread.Start(); }
        private void Copy()
        {
            try
            {
                byte[] bytes = new byte[65536];
                while (true) { int count = reader.Read(bytes, 0, bytes.Length); if (count == 0) break; destination.Write(bytes, 0, count); Bytes = checked(Bytes + count); }
                destination.Flush(); complete = true;
            }
            catch (IOException) { }
            catch (OverflowException) { }
            catch (ObjectDisposedException) { }
            finally { done.Set(); }
        }
        internal void Wait(int milliseconds) { done.WaitOne(milliseconds); }
        public void Dispose() { reader.Dispose(); if (thread == null || thread.Join(2000)) done.Dispose(); }
    }

    private sealed class HostLaunch : IDisposable
    {
        private readonly NexaConnectorHostJob job = new NexaConnectorHostJob();
        private HostOutputPump stdout, stderr;
        internal bool RootCreated { get { return job.RootCreated; } }
        internal long StdoutBytes { get { return stdout == null ? 0 : stdout.Bytes; } }
        internal long StderrBytes { get { return stderr == null ? 0 : stderr.Bytes; } }
        internal bool OutputComplete { get { return stdout != null && stderr != null && stdout.Complete && stderr.Complete; } }
        internal bool TreeRunning { get { return job.TreeRunning; } }
        internal bool TryRootExit(out uint exit) { return job.TryRootExit(out exit); }
        internal void StopAndJoin() { job.StopAndJoin(); }
        internal void WaitOutput(int milliseconds) { if (stdout != null) stdout.Wait(milliseconds); if (stderr != null) stderr.Wait(milliseconds); }
        internal void Start(string encoded, CancellationToken cancellation)
        {
            SafeFileHandle input = null, output = null, error = null, outputRead = null, errorRead = null;
            try
            {
                string json = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(encoded));
                JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 50000, RecursionLimit = 4 };
                Dictionary<string, object> launch = serializer.Deserialize<Dictionary<string, object>>(json);
                if (launch == null || launch.Count != 3 || !launch.ContainsKey("executable") || !launch.ContainsKey("arguments") || !launch.ContainsKey("windowsVerbatimArguments")) throw new InvalidOperationException("launch-contract");
                string executable = launch["executable"] as string;
                object[] argv = launch["arguments"] as object[];
                ArrayList list = launch["arguments"] as ArrayList;
                if (argv == null && list != null) argv = list.ToArray();
                if (String.IsNullOrEmpty(executable) || executable.Length > 4096 || executable.IndexOf('\0') >= 0 || argv == null || argv.Length > 1024 || !(launch["windowsVerbatimArguments"] is bool)) throw new InvalidOperationException("launch-contract");
                bool verbatim = (bool)launch["windowsVerbatimArguments"];
                StringBuilder command = new StringBuilder(NexaConnectorHostJob.Quote(executable));
                foreach (object value in argv)
                {
                    string argument = value as string;
                    if (argument == null || argument.IndexOf('\0') >= 0 || argument.Length > 32767) throw new InvalidOperationException("launch-argument");
                    command.Append(' ').Append(verbatim ? argument : NexaConnectorHostJob.Quote(argument));
                }
                if (command.Length > 32766) throw new InvalidOperationException("launch-length");
                IntPtr self = GetCurrentProcess();
                if (!DuplicateHandle(self, GetStdHandle(-10), self, out input, 0, true, 2)) throw new InvalidOperationException("stdin-duplicate");
                SecurityAttributes security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
                if (!CreatePipe(out outputRead, out output, ref security, 65536) || !SetHandleInformation(outputRead, 1, 0) || !CreatePipe(out errorRead, out error, ref security, 65536) || !SetHandleInformation(errorRead, 1, 0)) throw new InvalidOperationException("output-pipes");
                stdout = new HostOutputPump(outputRead, Console.OpenStandardOutput()); outputRead = null;
                stderr = new HostOutputPump(errorRead, Console.OpenStandardError()); errorRead = null;
                job.Launch(null, command, null, IntPtr.Zero, new SafeFileHandle[] { input, output, error }, IntPtr.Zero, cancellation);
                stdout.Start(); stderr.Start();
            }
            finally
            {
                if (input != null) input.Dispose(); if (output != null) output.Dispose(); if (error != null) error.Dispose();
                if (outputRead != null) outputRead.Dispose(); if (errorRead != null) errorRead.Dispose();
            }
        }
        public void Dispose() { job.Dispose(); if (stdout != null) stdout.Dispose(); if (stderr != null) stderr.Dispose(); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out SafeFileHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
}
