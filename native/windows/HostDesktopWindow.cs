// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

/// <summary>A selector binds a real HWND to its owning process generation and UI thread, never its title.</summary>
internal struct NexaConnectorHostWindowIdentity
{
    internal ulong Window;
    internal uint Process;
    internal ulong Created;
    internal uint Thread;
}

/// <summary>Keyboard tests provide a foreground lease without invoking any desktop API.</summary>
internal interface INexaConnectorHostKeyboardTarget : IDisposable
{
    void Focus();
    void Check();
}

/// <summary>One opened process generation owns all identity and foreground checks for an input operation.</summary>
internal sealed class NexaConnectorHostDesktopWindow : INexaConnectorHostKeyboardTarget
{
    private readonly NexaConnectorHostWindowIdentity identity;
    private readonly IntPtr window;
    private IntPtr process;

    private NexaConnectorHostDesktopWindow(NexaConnectorHostWindowIdentity value, IntPtr handle)
    {
        identity = value;
        window =
            IntPtr.Size == 8
                ? new IntPtr(unchecked((long)value.Window))
                : new IntPtr(unchecked((int)value.Window));
        process = handle;
    }

    /// <summary>Snapshots record only the actual foreground identity; failure never invents a target.</summary>
    internal static string ForegroundTarget()
    {
        return Observe(GetForegroundWindow());
    }

    /// <summary>The signed caller result carries this selector; it is not an independent authorization capability.</summary>
    internal static string Observe(IntPtr window)
    {
        IntPtr process = IntPtr.Zero;
        try
        {
            uint pid;
            uint thread = GetWindowThreadProcessId(window, out pid);
            if (window == IntPtr.Zero || thread == 0 || pid == 0 || !IsWindowVisible(window))
                return null;
            process = OpenProcess(0x00101000, false, pid);
            if (process == IntPtr.Zero || WaitForSingleObject(process, 0) != 258)
                return null;
            ulong created = Creation(process);
            string token = Format(
                new NexaConnectorHostWindowIdentity
                {
                    Window =
                        IntPtr.Size == 8
                            ? unchecked((ulong)window.ToInt64())
                            : unchecked((uint)window.ToInt32()),
                    Process = pid,
                    Created = created,
                    Thread = thread,
                }
            );
            using (NexaConnectorHostDesktopWindow verified = Acquire(token))
                verified.Verify();
            return token;
        }
        catch (Win32Exception)
        {
            return null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
        finally
        {
            if (process != IntPtr.Zero)
                CloseHandle(process);
        }
    }

    /// <summary>Application resolution compares the owning executable, independently of all window captions.</summary>
    internal static string ExecutablePath(IntPtr window)
    {
        uint pid;
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out pid) == 0 || pid == 0)
            return null;
        IntPtr process = OpenProcess(0x00101000, false, pid);
        if (process == IntPtr.Zero)
            return null;
        try
        {
            StringBuilder path = new StringBuilder(32768);
            uint length = (uint)path.Capacity;
            return QueryFullProcessImageNameW(process, 0, path, ref length) && length > 0
                ? path.ToString()
                : null;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    /// <summary>Exact fixed-width hexadecimal fields preserve pointer and FILETIME precision across JSON.</summary>
    internal static NexaConnectorHostWindowIdentity Parse(string token)
    {
        if (
            token == null
            || !Regex.IsMatch(
                token,
                "\\Awin32:v1:[0-9a-f]{16}:[0-9a-f]{8}:[0-9a-f]{16}:[0-9a-f]{8}\\z",
                RegexOptions.CultureInvariant
            )
        )
            throw new InvalidOperationException(
                token == null ? "keyboard-target-required" : "keyboard-target-invalid"
            );
        string[] parts = token.Split(new char[] { ':' });
        NexaConnectorHostWindowIdentity value = new NexaConnectorHostWindowIdentity
        {
            Window = UInt64.Parse(parts[2], NumberStyles.HexNumber, CultureInfo.InvariantCulture),
            Process = UInt32.Parse(parts[3], NumberStyles.HexNumber, CultureInfo.InvariantCulture),
            Created = UInt64.Parse(parts[4], NumberStyles.HexNumber, CultureInfo.InvariantCulture),
            Thread = UInt32.Parse(parts[5], NumberStyles.HexNumber, CultureInfo.InvariantCulture),
        };
        if (
            value.Window == 0
            || value.Process == 0
            || value.Created == 0
            || value.Thread == 0
            || (IntPtr.Size == 4 && value.Window > UInt32.MaxValue)
        )
            throw new InvalidOperationException("keyboard-target-invalid");
        return value;
    }

    internal static string Format(NexaConnectorHostWindowIdentity value)
    {
        return "win32:v1:"
            + value.Window.ToString("x16", CultureInfo.InvariantCulture)
            + ":"
            + value.Process.ToString("x8", CultureInfo.InvariantCulture)
            + ":"
            + value.Created.ToString("x16", CultureInfo.InvariantCulture)
            + ":"
            + value.Thread.ToString("x8", CultureInfo.InvariantCulture);
    }

    /// <summary>A process handle pins the generation while stale/dead HWNDs fail before foreground activation.</summary>
    internal static NexaConnectorHostDesktopWindow Acquire(string token)
    {
        NexaConnectorHostWindowIdentity value = Parse(token);
        IntPtr process = OpenProcess(0x00101000, false, value.Process);
        if (process == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "keyboard-target-unavailable");
        try
        {
            if (Creation(process) != value.Created)
                throw new InvalidOperationException("keyboard-target-stale");
            NexaConnectorHostDesktopWindow target = new NexaConnectorHostDesktopWindow(
                value,
                process
            );
            target.Verify();
            process = IntPtr.Zero;
            return target;
        }
        finally
        {
            if (process != IntPtr.Zero)
                CloseHandle(process);
        }
    }

    /// <summary>Windows may deny foreground restoration; never inject into whichever unrelated window remains active.</summary>
    public void Focus()
    {
        Verify();
        if (GetForegroundWindow() == window)
            return;
        if (IsIconic(window))
            ShowWindow(window, 9);
        SetForegroundWindow(window);
        Stopwatch elapsed = Stopwatch.StartNew();
        do
        {
            Verify();
            if (GetForegroundWindow() == window)
                return;
            Thread.Sleep(10);
        } while (elapsed.ElapsedMilliseconds < 250);
        throw new InvalidOperationException("keyboard-focus-denied");
    }

    public void Check()
    {
        Verify();
        if (GetForegroundWindow() != window)
            throw new InvalidOperationException("keyboard-focus-changed");
    }

    private void Verify()
    {
        uint pid;
        uint thread = GetWindowThreadProcessId(window, out pid);
        if (
            process == IntPtr.Zero
            || WaitForSingleObject(process, 0) != 258
            || !IsWindow(window)
            || thread != identity.Thread
            || pid != identity.Process
            || GetAncestor(window, 2) != window
        )
            throw new InvalidOperationException("keyboard-target-stale");
        if (!IsWindowVisible(window) || !IsWindowEnabled(window))
            throw new InvalidOperationException("keyboard-target-unavailable");
    }

    /// <summary>Accessibility providers bind the same process/window identity without a foreground requirement.</summary>
    internal IntPtr Handle
    {
        get { return window; }
    }
    internal uint ProcessId
    {
        get { return identity.Process; }
    }

    internal void CheckIdentity()
    {
        Verify();
    }

    public void Dispose()
    {
        if (process != IntPtr.Zero)
        {
            CloseHandle(process);
            process = IntPtr.Zero;
        }
    }

    private static ulong Creation(IntPtr process)
    {
        FileTime created;
        FileTime exited;
        FileTime kernel;
        FileTime user;
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "keyboard-target-unavailable");
        return ((ulong)created.High << 32) | created.Low;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        internal uint Low;
        internal uint High;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint access,
        [MarshalAs(UnmanagedType.Bool)] bool inherit,
        uint pid
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FileTime created,
        out FileTime exited,
        out FileTime kernel,
        out FileTime user
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(
        IntPtr process,
        uint flags,
        StringBuilder path,
        ref uint length
    );
}
