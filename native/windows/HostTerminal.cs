// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

/// <summary>A full-user terminal uses real ConPTY and the shared Job owner; it grants no sandbox or managed-lock semantics.</summary>
public static class NexaConnectorHostTerminal
{
    public static int Run(string[] arguments)
    {
        if (arguments.Length == 1 && arguments[0] == "--terminal-probe")
        {
            bool supported = false;
            try
            {
                using (
                    NexaConnectorHostTerminalConsole terminal =
                        new NexaConnectorHostTerminalConsole(
                            80,
                            24,
                            true,
                            delegate(bool complete, long total) { },
                            delegate() { }
                        )
                )
                {
                    supported = true;
                }
            }
            catch
            {
                supported = false;
            }
            Console.Out.WriteLine(supported ? "{\"supported\":true}" : "{\"supported\":false}");
            return 0;
        }
        try
        {
            if (arguments.Length != 4 || arguments[0] != "--terminal")
            {
                throw new InvalidOperationException();
            }
            NexaConnectorHostTerminalProtocol.ValidateChannel(arguments[2], arguments[3]);
            NexaConnectorHostTerminalProtocol.Launch launch =
                NexaConnectorHostTerminalProtocol.ParseLaunch(arguments[1]);
            using (Driver driver = new Driver(arguments[2], arguments[3]))
            {
                return driver.Run(launch);
            }
        }
        catch (EntryPointNotFoundException)
        {
            Console.Error.WriteLine("Windows pseudoconsole support is unavailable.");
            return 70;
        }
        catch (NotSupportedException)
        {
            Console.Error.WriteLine("Windows pseudoconsole support is unavailable.");
            return 70;
        }
        catch
        {
            Console.Error.WriteLine(
                "Windows terminal could not complete securely; process state may require explicit recovery."
            );
            return 70;
        }
    }

    /// <summary>Only this thread queries or changes Job lifetime; bounded control input never runs user code.</summary>
    private sealed class Driver : IDisposable
    {
        private readonly NamedPipeClientStream channel;
        private readonly string token;
        private readonly CancellationTokenSource stop = new CancellationTokenSource();
        private readonly object gate = new object();
        private readonly object writeGate = new object();
        private readonly List<NexaConnectorHostTerminalProtocol.Control> controls =
            new List<NexaConnectorHostTerminalProtocol.Control>();
        private readonly ConsoleCancelEventHandler interrupt;
        private readonly ManualResetEvent authentication = new ManualResetEvent(false);
        private Thread reader;
        private bool parentLost;
        private bool disposed;
        private bool outputComplete;
        private bool authenticated;
        private long outputBytes;
        private bool running = true;
        private uint? exitCode;
        private bool? treeRunning;
        private string previous;

        internal Driver(string path, string token)
        {
            this.token = token;
            channel = new NamedPipeClientStream(
                ".",
                path.Substring(9),
                PipeDirection.InOut,
                PipeOptions.Asynchronous
            );
            interrupt = delegate(object sender, ConsoleCancelEventArgs arguments)
            {
                arguments.Cancel = true;
                Lost();
            };
            Console.CancelKeyPress += interrupt;
        }

        internal int Run(NexaConnectorHostTerminalProtocol.Launch launch)
        {
            channel.Connect(10000);
            reader = new Thread(Read);
            reader.IsBackground = true;
            reader.Start();
            Send(new Dictionary<string, object> { { "kind", "hello" } });
            if (!authentication.WaitOne(10000))
            {
                throw new InvalidOperationException("terminal-parent-authentication");
            }
            lock (gate)
            {
                if (!authenticated || parentLost)
                {
                    throw new InvalidOperationException("terminal-parent-authentication");
                }
            }
            NexaConnectorHostJob job = new NexaConnectorHostJob();
            NexaConnectorHostTerminalConsole terminal = null;
            bool closingFailed = false;
            try
            {
                terminal = new NexaConnectorHostTerminalConsole(
                    launch.Cols,
                    launch.Rows,
                    false,
                    Completed,
                    Lost
                );
                job.Launch(
                    null,
                    launch.Command,
                    null,
                    IntPtr.Zero,
                    new SafeFileHandle[0],
                    terminal.Handle,
                    stop.Token
                );
                Send(
                    new Dictionary<string, object>
                    {
                        { "kind", "ready" },
                        { "cols", (int)launch.Cols },
                        { "rows", (int)launch.Rows },
                    }
                );
                terminal.StartInput(Accepted, Lost);
                while (true)
                {
                    NexaConnectorHostTerminalProtocol.Control control = null;
                    bool lost;
                    lock (gate)
                    {
                        if (controls.Count != 0)
                        {
                            control = controls[0];
                            controls.RemoveAt(0);
                        }
                        lost = parentLost;
                    }
                    if (lost)
                    {
                        job.StopAndJoin();
                        terminal.AbandonOutput();
                        terminal.Dispose();
                        return 74;
                    }
                    if (control != null)
                    {
                        if (control.Stop)
                        {
                            try
                            {
                                job.StopAndJoin();
                                terminal.Dispose();
                                Observe(job);
                                Publish();
                                Reply(control.Id, true);
                                return 0;
                            }
                            catch (NexaConnectorHostJobUnconfirmedException)
                            {
                                treeRunning = null;
                                Publish();
                                Reply(control.Id, false);
                            }
                            catch (IOException)
                            {
                                closingFailed = true;
                                try
                                {
                                    Observe(job);
                                }
                                catch (NexaConnectorHostJobUnconfirmedException)
                                {
                                    treeRunning = null;
                                }
                                Publish();
                                Reply(control.Id, false);
                            }
                        }
                        else
                        {
                            try
                            {
                                terminal.Resize(control.Cols, control.Rows);
                                Reply(control.Id, true);
                            }
                            catch (IOException)
                            {
                                Reply(control.Id, false);
                            }
                        }
                    }
                    try
                    {
                        Observe(job);
                        if (treeRunning == false && !closingFailed)
                        {
                            try
                            {
                                terminal.Dispose();
                                Publish();
                                return 0;
                            }
                            catch (IOException)
                            {
                                closingFailed = true;
                            }
                        }
                    }
                    catch (NexaConnectorHostJobUnconfirmedException)
                    {
                        treeRunning = null;
                    }
                    Publish();
                    Thread.Sleep(20);
                }
            }
            finally
            {
                // ConPTY teardown begins only after the shared owner has confirmed complete Job quiescence.
                job.Dispose();
                if (terminal != null)
                {
                    terminal.Dispose();
                }
            }
        }

        private void Observe(NexaConnectorHostJob job)
        {
            uint exit;
            treeRunning = job.TreeRunning;
            if (job.TryRootExit(out exit))
            {
                running = false;
                exitCode = exit;
            }
        }

        private void Read()
        {
            try
            {
                NexaConnectorHostTerminalProtocol.ValidateStart(
                    NexaConnectorHostTerminalProtocol.ReadControl(channel),
                    token
                );
                lock (gate)
                {
                    authenticated = true;
                }
                authentication.Set();
                int count = 0;
                while (true)
                {
                    string line = NexaConnectorHostTerminalProtocol.ReadControl(channel);
                    if (line == null)
                    {
                        break;
                    }
                    if (++count > 4096)
                    {
                        throw new InvalidOperationException();
                    }
                    NexaConnectorHostTerminalProtocol.Control control =
                        NexaConnectorHostTerminalProtocol.ParseControl(line, token);
                    if (control.Stop)
                    {
                        try
                        {
                            stop.Cancel();
                        }
                        catch (AggregateException) { }
                    }
                    lock (gate)
                    {
                        if (controls.Count >= 16)
                        {
                            throw new InvalidOperationException();
                        }
                        controls.Add(control);
                    }
                }
            }
            catch (Exception) { }
            finally
            {
                authentication.Set();
                Lost();
            }
        }

        private void Lost()
        {
            lock (gate)
            {
                parentLost = true;
            }
            try
            {
                stop.Cancel();
            }
            catch (ObjectDisposedException) { }
            catch (AggregateException) { }
        }

        private void Accepted(long bytes)
        {
            Send(
                new Dictionary<string, object>
                {
                    { "kind", "input" },
                    { "acceptedBytes", bytes.ToString(CultureInfo.InvariantCulture) },
                }
            );
        }

        private void Completed(bool complete, long bytes)
        {
            lock (gate)
            {
                outputComplete = complete;
                outputBytes = bytes;
            }
        }

        private void Reply(string id, bool ok)
        {
            Send(
                new Dictionary<string, object>
                {
                    { "kind", "control" },
                    { "id", id },
                    { "ok", ok },
                }
            );
        }

        private void Publish()
        {
            Dictionary<string, object> value;
            lock (gate)
            {
                value = new Dictionary<string, object>
                {
                    { "kind", "state" },
                    { "running", running },
                    { "treeRunning", treeRunning.HasValue ? (object)treeRunning.Value : null },
                    { "exitCode", exitCode.HasValue ? (object)(long)exitCode.Value : null },
                    { "signal", null },
                    { "outputComplete", outputComplete },
                    {
                        "outputFinalBytes",
                        outputComplete ? outputBytes.ToString(CultureInfo.InvariantCulture) : null
                    },
                };
            }
            string encoded = new JavaScriptSerializer().Serialize(value);
            if (encoded == previous)
            {
                return;
            }
            previous = encoded;
            Send(value);
        }

        private void Send(Dictionary<string, object> value)
        {
            lock (writeGate)
            {
                try
                {
                    value.Add("token", token);
                    byte[] bytes = Encoding.UTF8.GetBytes(
                        new JavaScriptSerializer().Serialize(value) + "\n"
                    );
                    if (bytes.Length > 4096)
                    {
                        throw new InvalidOperationException();
                    }
                    IAsyncResult sent = channel.BeginWrite(bytes, 0, bytes.Length, null, null);
                    if (!sent.AsyncWaitHandle.WaitOne(5000))
                    {
                        Lost();
                        channel.Dispose();
                        return;
                    }
                    try
                    {
                        channel.EndWrite(sent);
                    }
                    finally
                    {
                        sent.AsyncWaitHandle.Dispose();
                    }
                }
                catch (IOException)
                {
                    Lost();
                }
                catch (ObjectDisposedException)
                {
                    Lost();
                }
                catch (InvalidOperationException)
                {
                    Lost();
                }
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            Console.CancelKeyPress -= interrupt;
            channel.Dispose();
            if (reader != null && !reader.Join(3000))
            {
                throw new IOException("terminal-control-close-unconfirmed");
            }
            authentication.Dispose();
            stop.Dispose();
        }
    }
}
