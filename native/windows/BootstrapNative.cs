// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

/// <summary>Native bootstrap layout and imports remain separate from release orchestration.</summary>
public static partial class NexaConnectorStateOwner
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BootstrapSystemInfo
    {
        internal ushort Architecture;
        internal ushort Reserved;
        internal uint PageSize;
        internal IntPtr Minimum;
        internal IntPtr Maximum;
        internal IntPtr Mask;
        internal uint Processors;
        internal uint Type;
        internal uint Granularity;
        internal ushort Level;
        internal ushort Revision;
    }

    [DllImport("kernel32.dll")]
    private static extern void GetNativeSystemInfo(out BootstrapSystemInfo information);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFilePointerEx(
        SafeFileHandle file,
        long distance,
        out long position,
        uint origin
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle file,
        StringBuilder path,
        uint size,
        uint flags
    );
}
