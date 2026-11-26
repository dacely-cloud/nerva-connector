// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

/// <summary>An authenticated host-user broker retains its job after root exit; it is deliberately not a sandbox.</summary>
public static partial class NexaConnectorHostProcess
{
    public static int Main(string[] arguments)
    {
        if (arguments.Length == 2 && arguments[0] == "--connector-update")
        {
            return NexaConnectorUpdateCommand.Request(arguments[1]);
        }
        if (arguments.Length == 1 && arguments[0] == "--desktop")
        {
            return NexaConnectorHostDesktop.Run();
        }
        if (
            arguments.Length > 0
            && (arguments[0] == "--terminal" || arguments[0] == "--terminal-probe")
        )
        {
            return NexaConnectorHostTerminal.Run(arguments);
        }
        if (
            arguments.Length != 3
            || arguments[0].Length > 30000
            || !arguments[1]
                .StartsWith("\\\\.\\pipe\\nerva-connector-host-", StringComparison.Ordinal)
            || arguments[2].Length != 36
        )
        {
            return 70;
        }
        try
        {
            using (
                NamedPipeClientStream channel = new NamedPipeClientStream(
                    ".",
                    arguments[1].Substring(9),
                    PipeDirection.InOut,
                    PipeOptions.Asynchronous
                )
            )
            {
                channel.Connect(10000);
                Send(
                    channel,
                    new Dictionary<string, object>
                    {
                        { "token", arguments[2] },
                        { "kind", "ready" },
                    }
                );
                StreamReader reader = new StreamReader(
                    channel,
                    new UTF8Encoding(false, true),
                    false,
                    256,
                    true
                );
                if (ReadControl(reader, arguments[2]) != "start")
                {
                    return 70;
                }
                using (HostControl control = new HostControl(reader, arguments[2]))
                using (HostLaunch launch = new HostLaunch())
                {
                    bool failed = false;
                    bool stopAfterFailure = false;
                    bool rejected = false;
                    Exception launchError = null;
                    try
                    {
                        launch.Start(arguments[0], control.Cancellation);
                        Send(
                            channel,
                            new Dictionary<string, object>
                            {
                                { "token", arguments[2] },
                                { "kind", "started" },
                            }
                        );
                    }
                    catch (Exception error)
                    {
                        failed = true;
                        stopAfterFailure = true;
                        launchError = error;
                    }
                    bool reported = false;
                    bool reportedOutput = false;
                    bool rootUnavailable = false;
                    bool? reportedTree = null;
                    while (true)
                    {
                        if (control.TakeStop() || stopAfterFailure)
                        {
                            stopAfterFailure = false;
                            try
                            {
                                launch.StopAndJoin();
                                if (launch.RootCreated)
                                {
                                    launch.WaitOutput(1000);
                                }
                            }
                            catch (NexaConnectorHostJobUnconfirmedException)
                            {
                                if (control.Disconnected)
                                {
                                    Environment.Exit(74);
                                }
                                Send(
                                    channel,
                                    new Dictionary<string, object>
                                    {
                                        { "token", arguments[2] },
                                        { "kind", "stop-failed" },
                                    }
                                );
                                control.Wait(100);
                                continue;
                            }
                        }
                        uint rootExit;
                        bool exited;
                        try
                        {
                            exited = launch.TryRootExit(out rootExit);
                            rootUnavailable = false;
                        }
                        catch (NexaConnectorHostJobUnconfirmedException)
                        {
                            if (control.Disconnected)
                            {
                                Environment.Exit(74);
                            }
                            if (!rootUnavailable)
                            {
                                Send(
                                    channel,
                                    new Dictionary<string, object>
                                    {
                                        { "token", arguments[2] },
                                        { "kind", "stop-failed" },
                                    }
                                );
                            }
                            rootUnavailable = true;
                            control.Wait(100);
                            continue;
                        }
                        if (exited || (failed && !launch.RootCreated))
                        {
                            bool? tree = null;
                            try
                            {
                                tree = launch.TreeRunning;
                            }
                            catch (NexaConnectorHostJobUnconfirmedException) { }
                            bool complete = launch.OutputComplete || !launch.RootCreated;
                            if (!rejected && failed && !launch.RootCreated && tree == false)
                            {
                                Send(channel, Rejection(arguments[2], launchError));
                                rejected = true;
                            }
                            if (!reported || tree != reportedTree || (complete && !reportedOutput))
                            {
                                Report(
                                    channel,
                                    arguments[2],
                                    exited ? (long?)rootExit : null,
                                    failed,
                                    tree,
                                    complete ? (long?)launch.StdoutBytes : null,
                                    complete ? (long?)launch.StderrBytes : null
                                );
                                reported = true;
                                reportedTree = tree;
                                reportedOutput = complete;
                            }
                            if (tree == false && (complete || control.Stopping || failed))
                            {
                                return failed ? 70 : 0;
                            }
                        }
                        if (control.Disconnected)
                        {
                            Environment.Exit(74);
                        }
                        control.Wait(100);
                    }
                }
            }
        }
        catch
        {
            return 70;
        }
    }

    /// <summary>This frame is emitted only after the caller proves no root was created and the owned job is empty.</summary>
    internal static Dictionary<string, object> Rejection(string token, Exception error)
    {
        NexaConnectorHostCreateException create = error as NexaConnectorHostCreateException;
        return new Dictionary<string, object>
        {
            { "token", token },
            { "kind", "launch-rejected" },
            {
                "errorCode",
                create != null ? create.ErrorCode
                : error is OperationCanceledException ? "canceled"
                : "operation-failed"
            },
            { "nativeError", create != null ? (object)create.NativeError : null },
        };
    }

    private static void Send(Stream channel, Dictionary<string, object> value)
    {
        byte[] report = new UTF8Encoding(false, true).GetBytes(
            new JavaScriptSerializer().Serialize(value) + "\n"
        );
        if (report.Length > 1024)
        {
            throw new InvalidOperationException("host-report-limit");
        }
        channel.Write(report, 0, report.Length);
        channel.Flush();
    }

    private static void Report(
        Stream channel,
        string token,
        long? exit,
        bool failed,
        bool? tree,
        long? stdout,
        long? stderr
    )
    {
        Send(
            channel,
            new Dictionary<string, object>
            {
                { "token", token },
                { "kind", "report" },
                { "exitCode", exit },
                { "signal", null },
                { "launchFailed", failed },
                { "treeRunning", tree },
                {
                    "stdoutFinalBytes",
                    stdout.HasValue ? stdout.Value.ToString(CultureInfo.InvariantCulture) : null
                },
                {
                    "stderrFinalBytes",
                    stderr.HasValue ? stderr.Value.ToString(CultureInfo.InvariantCulture) : null
                },
            }
        );
    }

    private static string ReadControl(TextReader reader, string token)
    {
        StringBuilder line = new StringBuilder();
        while (line.Length <= 256)
        {
            int value = reader.Read();
            if (value < 0)
            {
                throw new EndOfStreamException();
            }
            if (value == 10)
            {
                JavaScriptSerializer json = new JavaScriptSerializer
                {
                    MaxJsonLength = 256,
                    RecursionLimit = 2,
                };
                Dictionary<string, object> control = json.Deserialize<Dictionary<string, object>>(
                    line.ToString()
                );
                if (
                    control == null
                    || control.Count != 2
                    || !control.ContainsKey("token")
                    || !control.ContainsKey("operation")
                    || !(control["token"] is string)
                    || (string)control["token"] != token
                    || !(control["operation"] is string)
                )
                {
                    throw new InvalidOperationException("host-control-invalid");
                }
                return (string)control["operation"];
            }
            line.Append((char)value);
        }
        throw new InvalidOperationException("host-control-limit");
    }
}
