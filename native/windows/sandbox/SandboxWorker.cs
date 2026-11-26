// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

/// <summary>Fixed harmless canary worker. There is no command parser, secret reader or fallback execution mode.</summary>
internal static class SandboxWorker
{
    public static int Main(string[] arguments)
    {
        try
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                return 2;
            }
            SandboxPolicy.Layout();
            if (arguments.Length == 1 && arguments[0] == "--child-canary")
            {
                return 71;
            }
            if (arguments.Length < 2)
            {
                return 2;
            }
            SandboxToken.Verify(SandboxNative.GetCurrentProcess(), arguments[1]);
            if (arguments.Length == 2 && arguments[0] == "--wait")
            {
                Report("NEXA_SANDBOX_WAIT_V1\n");
                Thread.Sleep(Timeout.Infinite);
                return 2;
            }
            if (arguments.Length != 7 || arguments[0] != "--probe")
            {
                return 2;
            }
            int port;
            if (
                !Int32.TryParse(
                    arguments[6],
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out port
                )
                || port < 1
                || port > 65535
                || arguments[4].Length != 32
            )
            {
                return 2;
            }
            using (
                SafeFileHandle allowed = new SafeFileHandle(
                    SandboxPolicy.Handle(arguments[2]),
                    false
                )
            )
            using (
                SafeFileHandle excluded = new SafeFileHandle(
                    SandboxPolicy.Handle(arguments[3]),
                    false
                )
            )
            {
                byte[] data = new byte[33];
                uint read;
                if (
                    !SandboxNative.ReadFile(allowed, data, 33, out read, IntPtr.Zero)
                    || read != 32
                    || Encoding.ASCII.GetString(data, 0, 32) != arguments[4]
                )
                {
                    return 3;
                }
                uint written;
                if (
                    SandboxNative.WriteFile(allowed, new byte[] { 1 }, 1, out written, IntPtr.Zero)
                    || Marshal.GetLastWin32Error() != 5
                )
                {
                    return 3;
                }
                if (
                    SandboxNative.ReadFile(excluded, data, 1, out read, IntPtr.Zero)
                    || Marshal.GetLastWin32Error() != 6
                )
                {
                    return 3;
                }
                DeniedPath(arguments[5], 0x80000000);
                DeniedPath(arguments[5], 0x40000000);
                DeniedNetwork(port);
                DeniedChild();
                using (SHA256 hash = SHA256.Create())
                {
                    string digest = BitConverter
                        .ToString(hash.ComputeHash(Encoding.ASCII.GetBytes(arguments[4])))
                        .Replace("-", "")
                        .ToLowerInvariant();
                    Report("NEXA_SANDBOX_WORKER_V1:" + digest + "\n");
                }
            }
            return 0;
        }
        catch
        {
            return 4;
        }
    }

    private static void DeniedPath(string path, uint access)
    {
        using (
            SafeFileHandle file = SandboxNative.CreateFileW(
                path,
                access,
                3,
                IntPtr.Zero,
                3,
                0x00200000,
                IntPtr.Zero
            )
        )
        {
            if (!file.IsInvalid || Marshal.GetLastWin32Error() != 5)
            {
                throw new InvalidOperationException("ambient-access");
            }
        }
    }

    private static void DeniedNetwork(int port)
    {
        using (
            Socket socket = new Socket(
                AddressFamily.InterNetwork,
                SocketType.Stream,
                ProtocolType.Tcp
            )
        )
        {
            socket.Blocking = false;
            try
            {
                socket.Connect(new IPEndPoint(IPAddress.Loopback, port));
            }
            catch (SocketException error)
            {
                if (error.SocketErrorCode == SocketError.AccessDenied)
                {
                    return;
                }
                if (error.SocketErrorCode != SocketError.WouldBlock)
                {
                    throw;
                }
                if (!socket.Poll(1000000, SelectMode.SelectWrite))
                {
                    throw new InvalidOperationException("network-unconfirmed");
                }
                if (
                    (SocketError)
                        (int)
                            socket.GetSocketOption(SocketOptionLevel.Socket, SocketOptionName.Error)
                    == SocketError.AccessDenied
                )
                {
                    return;
                }
            }
            throw new InvalidOperationException("network-access");
        }
    }

    private static void DeniedChild()
    {
        string executable = Assembly.GetExecutingAssembly().Location;
        SandboxNative.StartupEx startup = new SandboxNative.StartupEx();
        startup.Startup.Size = Marshal.SizeOf(typeof(SandboxNative.Startup));
        SandboxNative.ProcessInformation process;
        if (
            SandboxNative.CreateProcessW(
                executable,
                new StringBuilder(SandboxPolicy.Quote(executable) + " --child-canary"),
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                4,
                IntPtr.Zero,
                null,
                ref startup,
                out process
            )
        )
        {
            try
            {
                SandboxNative.TerminateProcess(process.Process, 72);
                SandboxNative.WaitForSingleObject(process.Process, 2000);
            }
            finally
            {
                SandboxNative.CloseHandle(process.Thread);
                SandboxNative.CloseHandle(process.Process);
            }
            throw new InvalidOperationException("child-created");
        }
        int code = Marshal.GetLastWin32Error();
        if (!SandboxPolicy.ChildCreationDenied(code))
        {
            throw new InvalidOperationException("child-unconfirmed");
        }
    }

    private static void Report(string report)
    {
        byte[] data = Encoding.ASCII.GetBytes(report);
        using (SafeFileHandle output = new SafeFileHandle(SandboxNative.GetStdHandle(-11), false))
        {
            uint written;
            if (
                data.Length > SandboxPolicy.MaximumReport
                || !SandboxNative.WriteFile(
                    output,
                    data,
                    (uint)data.Length,
                    out written,
                    IntPtr.Zero
                )
                || written != data.Length
            )
            {
                throw new InvalidOperationException("report");
            }
        }
    }
}
