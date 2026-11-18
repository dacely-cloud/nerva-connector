// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

/// <summary>Known native Edit controls accept one bounded app/window-addressed replacement without global input or focus APIs.</summary>
internal sealed class NexaConnectorHostTextFieldEdit : INexaConnectorHostTextFieldValue
{
    private const uint TimeoutMs = 150;
    private const uint MessageFlags = 0x23;
    private readonly IntPtr root;
    private readonly IntPtr control;
    private readonly uint process;
    private readonly uint thread;
    private readonly string windowClass;

    private NexaConnectorHostTextFieldEdit(
        IntPtr root,
        IntPtr control,
        uint process,
        uint thread,
        string windowClass
    )
    {
        this.root = root;
        this.control = control;
        this.process = process;
        this.thread = thread;
        this.windowClass = windowClass;
    }

    internal static INexaConnectorHostTextFieldValue TryCreate(IntPtr root, IntPtr control)
    {
        if (
            control == IntPtr.Zero
            || control == root
            || !IsChild(root, control)
            || GetAncestor(control, 2) != root
        )
            return null;
        uint rootProcess;
        uint controlProcess;
        uint thread = GetWindowThreadProcessId(control, out controlProcess);
        if (
            GetWindowThreadProcessId(root, out rootProcess) == 0
            || thread == 0
            || rootProcess == 0
            || rootProcess != controlProcess
        )
            return null;
        string windowClass = Class(control);
        if (!SupportedClass(windowClass))
            return null;
        return new NexaConnectorHostTextFieldEdit(
            root,
            control,
            controlProcess,
            thread,
            windowClass
        );
    }

    internal static bool SupportedClass(string value)
    {
        return value != null
            && (
                String.Equals(value, "Edit", StringComparison.OrdinalIgnoreCase)
                || value.StartsWith("WindowsForms10.EDIT.", StringComparison.OrdinalIgnoreCase)
            );
    }

    public bool ReadOnly
    {
        get
        {
            Verify();
            ClearLastError(0);
            int style = GetWindowLongW(control, -16);
            int error = Marshal.GetLastWin32Error();
            if (style == 0 && error != 0)
                throw new Win32Exception(error, "keyboard-field-unavailable");
            return (style & 0x0800) != 0 || !IsWindowEnabled(control);
        }
    }

    public void Replace(string text)
    {
        Verify();
        if (ReadOnly)
            throw new InvalidOperationException("keyboard-field-read-only");
        IntPtr foreground = GetForegroundWindow();
        UIntPtr accepted;
        ClearLastError(0);
        if (
            SendText(control, 0x000C, UIntPtr.Zero, text, MessageFlags, TimeoutMs, out accepted)
                == IntPtr.Zero
            || accepted == UIntPtr.Zero
        )
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "keyboard-field-write-unconfirmed"
            );
        Verify();
        if (GetForegroundWindow() != foreground)
            throw new InvalidOperationException("keyboard-field-write-unconfirmed");
    }

    public string Value
    {
        get
        {
            Verify();
            IntPtr foreground = GetForegroundWindow();
            UIntPtr length;
            ClearLastError(0);
            if (
                SendCount(
                    control,
                    0x000E,
                    UIntPtr.Zero,
                    IntPtr.Zero,
                    MessageFlags,
                    TimeoutMs,
                    out length
                ) == IntPtr.Zero
                || length.ToUInt64() > 16384
            )
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "keyboard-field-write-unconfirmed"
                );
            StringBuilder value = new StringBuilder((int)length.ToUInt64() + 1);
            UIntPtr copied;
            ClearLastError(0);
            if (
                ReadText(
                    control,
                    0x000D,
                    new UIntPtr((uint)value.Capacity),
                    value,
                    MessageFlags,
                    TimeoutMs,
                    out copied
                ) == IntPtr.Zero
            )
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "keyboard-field-write-unconfirmed"
                );
            Verify();
            if (
                GetForegroundWindow() != foreground
                || copied.ToUInt64() > 16384
                || copied.ToUInt64() != (ulong)value.Length
            )
                throw new InvalidOperationException("keyboard-field-write-unconfirmed");
            return value.ToString();
        }
    }

    private void Verify()
    {
        uint rootProcess;
        uint controlProcess;
        if (
            !IsWindow(root)
            || !IsWindow(control)
            || GetWindowThreadProcessId(root, out rootProcess) == 0
            || GetWindowThreadProcessId(control, out controlProcess) != thread
            || rootProcess != process
            || controlProcess != process
            || !IsChild(root, control)
            || GetAncestor(control, 2) != root
            || !String.Equals(Class(control), windowClass, StringComparison.Ordinal)
        )
            throw new InvalidOperationException("keyboard-field-unavailable");
    }

    private static string Class(IntPtr window)
    {
        StringBuilder value = new StringBuilder(256);
        return GetClassNameW(window, value, value.Capacity) > 0 ? value.ToString() : null;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsChild(IntPtr parent, IntPtr child);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr window, StringBuilder name, int maximum);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowLongW(IntPtr window, int index);

    [DllImport("kernel32.dll", EntryPoint = "SetLastError")]
    private static extern void ClearLastError(uint error);

    [DllImport(
        "user32.dll",
        EntryPoint = "SendMessageTimeoutW",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    private static extern IntPtr SendText(
        IntPtr window,
        uint message,
        UIntPtr parameter,
        string text,
        uint flags,
        uint timeout,
        out UIntPtr result
    );

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    private static extern IntPtr SendCount(
        IntPtr window,
        uint message,
        UIntPtr parameter,
        IntPtr value,
        uint flags,
        uint timeout,
        out UIntPtr result
    );

    [DllImport(
        "user32.dll",
        EntryPoint = "SendMessageTimeoutW",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    private static extern IntPtr ReadText(
        IntPtr window,
        uint message,
        UIntPtr parameter,
        StringBuilder text,
        uint flags,
        uint timeout,
        out UIntPtr result
    );
}
