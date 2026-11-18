// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Runtime.InteropServices;
using System.Text;

/// <summary>Win32 desktop input layouts and imports use the exact native field order.</summary>
internal static partial class NexaConnectorHostDesktop
{
    /// <summary>Logical keyboard batches share the already qualified INPUT layout.</summary>
    private sealed class KeyboardSender : INexaConnectorHostKeyboardSender
    {
        private int error;

        public int Error
        {
            get { return error; }
        }

        public bool Down(ushort key)
        {
            return (GetAsyncKeyState(key) & 0x8000) != 0;
        }

        public uint Send(NexaConnectorHostKeyboardStroke[] strokes)
        {
            Input[] input = new Input[strokes.Length];
            for (int index = 0; index < strokes.Length; index++)
                input[index] = Keyboard(
                    strokes[index].Key,
                    strokes[index].Scan,
                    strokes[index].Flags
                );
            ClearLastError(0);
            uint accepted = SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Input)));
            error = Marshal.GetLastWin32Error();
            return accepted;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        internal uint Type;
        internal InputUnion Value;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        internal MouseInput Mouse;

        [FieldOffset(0)]
        internal KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        internal int X;
        internal int Y;
        internal uint Data;
        internal uint Flags;
        internal uint Time;
        internal UIntPtr Extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        internal ushort Key;
        internal ushort Scan;
        internal uint Flags;
        internal uint Time;
        internal UIntPtr Extra;
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [StructLayout(LayoutKind.Sequential)]
    private struct CursorPoint
    {
        internal int X;
        internal int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out CursorPoint point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);

    [DllImport("kernel32.dll", EntryPoint = "SetLastError")]
    private static extern void ClearLastError(uint error);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(
        uint flags,
        [MarshalAs(UnmanagedType.Bool)] bool inherit,
        uint access
    );

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformationW(
        IntPtr handle,
        int index,
        StringBuilder information,
        uint length,
        out uint needed
    );

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] input, int size);
}
