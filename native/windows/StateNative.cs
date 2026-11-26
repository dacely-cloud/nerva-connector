// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

/// <summary>Windows state ABI declarations preserve the exact field order and marshalling contract.</summary>
public static partial class NexaConnectorStateOwner
{
    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct UNICODE_STRING
        {
            internal ushort Length;
            internal ushort MaximumLength;
            internal IntPtr Buffer;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct OBJECT_ATTRIBUTES
        {
            internal int Length;
            internal IntPtr RootDirectory;
            internal IntPtr ObjectName;
            internal uint Attributes;
            internal IntPtr SecurityDescriptor;
            internal IntPtr SecurityQualityOfService;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct IO_STATUS_BLOCK
        {
            internal IntPtr Status;
            internal UIntPtr Information;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct OVERLAPPED
        {
            internal IntPtr Internal;
            internal IntPtr InternalHigh;
            internal uint Offset;
            internal uint OffsetHigh;
            internal IntPtr Event;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        internal static extern int SHGetKnownFolderPath(
            ref Guid folder,
            uint flags,
            IntPtr token,
            out IntPtr path
        );

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            ExactSpelling = true,
            SetLastError = true
        )]
        internal static extern uint QueryDosDeviceW(string name, [Out] char[] path, uint length);

        [DllImport("ntdll.dll")]
        internal static extern int NtCreateFile(
            out SafeFileHandle file,
            uint access,
            ref OBJECT_ATTRIBUTES attributes,
            out IO_STATUS_BLOCK result,
            IntPtr allocation,
            uint fileAttributes,
            uint share,
            uint disposition,
            uint options,
            IntPtr ea,
            uint eaLength
        );

        [DllImport("ntdll.dll")]
        internal static extern int NtSetInformationFile(
            SafeFileHandle file,
            out IO_STATUS_BLOCK result,
            IntPtr information,
            uint length,
            int kind
        );

        [DllImport("ntdll.dll")]
        internal static extern int NtQueryDirectoryFile(
            SafeFileHandle file,
            IntPtr action,
            IntPtr apc,
            IntPtr context,
            out IO_STATUS_BLOCK result,
            [Out] byte[] information,
            uint length,
            int kind,
            [MarshalAs(UnmanagedType.U1)] bool single,
            IntPtr name,
            [MarshalAs(UnmanagedType.U1)] bool restart
        );

        [DllImport("advapi32.dll")]
        internal static extern uint GetSecurityInfo(
            SafeFileHandle file,
            int kind,
            uint information,
            out IntPtr owner,
            out IntPtr group,
            out IntPtr dacl,
            out IntPtr sacl,
            out IntPtr descriptor
        );

        [DllImport("advapi32.dll")]
        internal static extern uint GetSecurityDescriptorLength(IntPtr descriptor);

        [DllImport("kernel32.dll")]
        internal static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file,
            int kind,
            [Out] byte[] information,
            uint size
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ReadFile(
            SafeFileHandle file,
            [Out] byte[] bytes,
            uint count,
            out uint read,
            IntPtr overlap
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WriteFile(
            SafeFileHandle file,
            byte[] bytes,
            uint count,
            out uint written,
            IntPtr overlap
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool FlushFileBuffers(SafeFileHandle file);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool LockFileEx(
            SafeFileHandle file,
            uint flags,
            uint reserved,
            uint low,
            uint high,
            ref OVERLAPPED overlap
        );
    }
}
