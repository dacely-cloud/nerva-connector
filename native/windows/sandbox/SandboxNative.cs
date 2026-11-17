// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

/// <summary>Windows SDK ABI used by the isolated qualification executable; all native failures fail closed.</summary>
internal static class SandboxNative
{
    [StructLayout(LayoutKind.Sequential)] internal struct Unicode { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] internal struct Attributes { internal int Length; internal IntPtr RootDirectory, ObjectName; internal uint Flags; internal IntPtr Descriptor, Quality; }
    [StructLayout(LayoutKind.Sequential)] internal struct IoStatus { internal IntPtr Status; internal UIntPtr Information; }
    [StructLayout(LayoutKind.Sequential)] internal struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
    [StructLayout(LayoutKind.Sequential)] internal struct SecurityCapabilities { internal IntPtr Sid, Capabilities; internal uint Count, Reserved; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct Startup { internal int Size; internal string Reserved, Desktop, Title; internal uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags; internal ushort Show, ReservedSize; internal IntPtr ReservedPointer, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] internal struct StartupEx { internal Startup Startup; internal IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInformation { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] internal struct JobBasicLimits { internal long ProcessTime, JobTime; internal uint Flags; internal UIntPtr MinimumWorkingSet, MaximumWorkingSet; internal uint ActiveProcesses; internal UIntPtr Affinity; internal uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] internal struct JobLimits { internal JobBasicLimits Basic; internal IoCounters Io; internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] internal struct Overlapped { internal IntPtr Internal, InternalHigh; internal uint Offset, OffsetHigh; internal IntPtr Event; }

    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] internal static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] internal static extern uint GetSystemWindowsDirectoryW([Out] char[] directory, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] internal static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, [Out] char[] name, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, [Out] char[] name, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetProcessMitigationPolicy(IntPtr process, SandboxMitigation kind, out uint policy, UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle source, IntPtr targetProcess, out SafeFileHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SecurityAttributes security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ReadFile(SafeFileHandle file, [Out] byte[] bytes, uint count, out uint read, IntPtr overlap);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool WriteFile(SafeFileHandle file, byte[] bytes, uint count, out uint written, IntPtr overlap);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool FlushFileBuffers(SafeFileHandle file);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetFilePointerEx(SafeFileHandle file, long distance, out long position, uint method);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool PeekNamedPipe(SafeFileHandle file, IntPtr buffer, uint size, IntPtr read, out uint available, IntPtr remaining);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool LockFileEx(SafeFileHandle file, uint flags, uint reserved, uint low, uint high, ref Overlapped overlap);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandleEx(SafeFileHandle file, SandboxFileInformation kind, [Out] byte[] bytes, uint count);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, byte[] bytes, uint count);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] internal static extern uint QueryDosDeviceW(string name, [Out] char[] path, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("ntdll.dll")] internal static extern int NtCreateFile(out SafeFileHandle file, uint access, ref Attributes attributes, out IoStatus result, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
    [DllImport("advapi32.dll")] internal static extern uint GetSecurityInfo(SafeFileHandle file, int kind, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] internal static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll")] internal static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool OpenProcessToken(IntPtr process, uint access, out SafeFileHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetTokenInformation(SafeFileHandle token, SandboxTokenField kind, IntPtr buffer, uint length, out uint returned);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetInformationJobObject(SafeFileHandle job, SandboxJobInformation kind, ref JobLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryInformationJobObject(SafeFileHandle job, SandboxJobInformation kind, out JobLimits limits, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsProcessInJob(IntPtr process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
}
