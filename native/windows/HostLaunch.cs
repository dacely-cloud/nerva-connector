// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

/// <summary>A validated host launch transfers only the exact inherited stream handles to its owned job.</summary>
public static partial class NexaConnectorHostProcess
{
    private sealed class HostLaunch : IDisposable
    {
        private readonly NexaConnectorHostJob job = new NexaConnectorHostJob();
        private HostOutputPump stdout;
        private HostOutputPump stderr;
        internal bool RootCreated
        {
            get { return job.RootCreated; }
        }
        internal long StdoutBytes
        {
            get { return stdout == null ? 0 : stdout.Bytes; }
        }
        internal long StderrBytes
        {
            get { return stderr == null ? 0 : stderr.Bytes; }
        }
        internal bool OutputComplete
        {
            get { return stdout != null && stderr != null && stdout.Complete && stderr.Complete; }
        }
        internal bool TreeRunning
        {
            get { return job.TreeRunning; }
        }

        internal bool TryRootExit(out uint exit)
        {
            return job.TryRootExit(out exit);
        }

        internal void StopAndJoin()
        {
            job.StopAndJoin();
        }

        internal void WaitOutput(int milliseconds)
        {
            if (stdout != null)
            {
                stdout.Wait(milliseconds);
            }
            if (stderr != null)
            {
                stderr.Wait(milliseconds);
            }
        }

        internal void Start(string encoded, CancellationToken cancellation)
        {
            SafeFileHandle input = null;
            SafeFileHandle output = null;
            SafeFileHandle error = null;
            SafeFileHandle outputRead = null;
            SafeFileHandle errorRead = null;
            try
            {
                string json = new UTF8Encoding(false, true).GetString(
                    Convert.FromBase64String(encoded)
                );
                JavaScriptSerializer serializer = new JavaScriptSerializer
                {
                    MaxJsonLength = 50000,
                    RecursionLimit = 4,
                };
                Dictionary<string, object> launch = serializer.Deserialize<
                    Dictionary<string, object>
                >(json);
                if (
                    launch == null
                    || launch.Count != 3
                    || !launch.ContainsKey("executable")
                    || !launch.ContainsKey("arguments")
                    || !launch.ContainsKey("windowsVerbatimArguments")
                )
                {
                    throw new InvalidOperationException("launch-contract");
                }
                string executable = launch["executable"] as string;
                object[] argv = launch["arguments"] as object[];
                ArrayList list = launch["arguments"] as ArrayList;
                if (argv == null && list != null)
                {
                    argv = list.ToArray();
                }
                if (
                    String.IsNullOrEmpty(executable)
                    || executable.Length > 4096
                    || executable.IndexOf('\0') >= 0
                    || argv == null
                    || argv.Length > 1024
                    || !(launch["windowsVerbatimArguments"] is bool)
                )
                {
                    throw new InvalidOperationException("launch-contract");
                }
                bool verbatim = (bool)launch["windowsVerbatimArguments"];
                StringBuilder command = new StringBuilder(NexaConnectorHostJob.Quote(executable));
                foreach (object value in argv)
                {
                    string argument = value as string;
                    if (argument == null || argument.IndexOf('\0') >= 0 || argument.Length > 32767)
                    {
                        throw new InvalidOperationException("launch-argument");
                    }
                    command
                        .Append(' ')
                        .Append(verbatim ? argument : NexaConnectorHostJob.Quote(argument));
                }
                if (command.Length > 32766)
                {
                    throw new InvalidOperationException("launch-length");
                }
                IntPtr self = GetCurrentProcess();
                if (!DuplicateHandle(self, GetStdHandle(-10), self, out input, 0, true, 2))
                {
                    throw new InvalidOperationException("stdin-duplicate");
                }
                SecurityAttributes security = new SecurityAttributes
                {
                    Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                    Inherit = true,
                };
                if (
                    !CreatePipe(out outputRead, out output, ref security, 65536)
                    || !SetHandleInformation(outputRead, 1, 0)
                    || !CreatePipe(out errorRead, out error, ref security, 65536)
                    || !SetHandleInformation(errorRead, 1, 0)
                )
                {
                    throw new InvalidOperationException("output-pipes");
                }
                stdout = new HostOutputPump(outputRead, Console.OpenStandardOutput());
                outputRead = null;
                stderr = new HostOutputPump(errorRead, Console.OpenStandardError());
                errorRead = null;
                job.Launch(
                    null,
                    command,
                    null,
                    IntPtr.Zero,
                    new SafeFileHandle[] { input, output, error },
                    IntPtr.Zero,
                    cancellation
                );
                stdout.Start();
                stderr.Start();
            }
            finally
            {
                if (input != null)
                {
                    input.Dispose();
                }
                if (output != null)
                {
                    output.Dispose();
                }
                if (error != null)
                {
                    error.Dispose();
                }
                if (outputRead != null)
                {
                    outputRead.Dispose();
                }
                if (errorRead != null)
                {
                    errorRead.Dispose();
                }
            }
        }

        public void Dispose()
        {
            job.Dispose();
            if (stdout != null)
            {
                stdout.Dispose();
            }
            if (stderr != null)
            {
                stderr.Dispose();
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr Descriptor;

        [MarshalAs(UnmanagedType.Bool)]
        internal bool Inherit;
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int kind);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess,
        IntPtr source,
        IntPtr targetProcess,
        out SafeFileHandle target,
        uint access,
        [MarshalAs(UnmanagedType.Bool)] bool inherit,
        uint options
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(
        out SafeFileHandle read,
        out SafeFileHandle write,
        ref SecurityAttributes attributes,
        uint size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
}
