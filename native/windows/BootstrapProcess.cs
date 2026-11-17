// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>Unknown descendant quiescence preserves the installer's private recovery directory.</summary>
internal sealed class NexaConnectorBootstrapQuiescenceException : Exception
{
    internal NexaConnectorBootstrapQuiescenceException() : base("bootstrap-process-quiescence-unconfirmed") { }
}

/// <summary>A fixed native launcher owns its complete child job before the initial thread can execute.</summary>
internal static class NexaConnectorBootstrapProcess
{
    internal static int Run(string executable, string[] arguments, string directory, bool interactive, CancellationToken cancellation = default(CancellationToken))
    {
        if (!Canonical(executable) || !Canonical(directory) || arguments == null || arguments.Length > 64) throw Invalid();
        StringBuilder command = new StringBuilder(Quote(executable));
        foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
        if (command.Length > 32766) throw Invalid();
        ProcessInformation child = new ProcessInformation();
        IntPtr attributes = IntPtr.Zero, inherited = IntPtr.Zero, assignedJobs = IntPtr.Zero, environment = IntPtr.Zero;
        bool initialized = false, attempted = false;
        int canceled = 0;
        ConsoleCancelEventHandler cancel = delegate(object sender, ConsoleCancelEventArgs eventArgs) { eventArgs.Cancel = true; Interlocked.Exchange(ref canceled, 1); };
        SafeFileHandle job = null, input = null, output = null, error = null;
        Console.CancelKeyPress += cancel;
        try
        {
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == null || job.IsInvalid) throw Invalid();
            JobLimits limits = new JobLimits { Basic = new JobBasicLimits { Flags = 0x2000 } };
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits)))) throw Invalid();
            SecurityAttributes security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
            input = CreateFileW(interactive ? "CONIN$" : "NUL", interactive ? 0xC0000000U : 0x80000000U, 3, ref security, 3, 0, IntPtr.Zero);
            if (input == null || input.IsInvalid) throw Invalid();
            output = DuplicateStandard(-11);
            error = DuplicateStandard(-12);
            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == UIntPtr.Zero || size.ToUInt64() > 1048576) throw Invalid();
            attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw Invalid();
            initialized = true;
            inherited = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(inherited, 0, input.DangerousGetHandle());
            Marshal.WriteIntPtr(inherited, IntPtr.Size, output.DangerousGetHandle());
            Marshal.WriteIntPtr(inherited, 2 * IntPtr.Size, error.DangerousGetHandle());
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), inherited, new UIntPtr((uint)(3 * IntPtr.Size)), IntPtr.Zero, IntPtr.Zero)) throw Invalid();
            assignedJobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(assignedJobs, job.DangerousGetHandle());
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), assignedJobs, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw Invalid();
            environment = Marshal.StringToHGlobalUni(EnvironmentBlock(Environment.GetEnvironmentVariables()));
            StartupEx startup = new StartupEx { Attributes = attributes };
            startup.Startup.Size = Marshal.SizeOf(typeof(StartupEx));
            startup.Startup.Flags = 0x100;
            startup.Startup.Input = input.DangerousGetHandle();
            startup.Startup.Output = output.DangerousGetHandle();
            startup.Startup.Error = error.DangerousGetHandle();
            cancellation.ThrowIfCancellationRequested();
            if (Interlocked.CompareExchange(ref canceled, 0, 0) != 0) throw new OperationCanceledException();
            attempted = true;
            if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80404, environment, directory, ref startup, out child)) throw Invalid();
            bool member;
            if (!IsProcessInJob(child.Process, job, out member) || !member) throw Invalid();
            cancellation.ThrowIfCancellationRequested();
            if (Interlocked.CompareExchange(ref canceled, 0, 0) != 0) throw new OperationCanceledException();
            if (ResumeThread(child.Thread) != 1) throw Invalid();
            CloseHandle(child.Thread); child.Thread = IntPtr.Zero;
            while (true)
            {
                cancellation.ThrowIfCancellationRequested();
                if (Interlocked.CompareExchange(ref canceled, 0, 0) != 0) throw new OperationCanceledException();
                uint waited = WaitForSingleObject(child.Process, 100);
                if (waited == 0) break;
                if (waited != 258) throw Invalid();
            }
            uint exit;
            if (!GetExitCodeProcess(child.Process, out exit)) throw Invalid();
            CloseHandle(child.Process); child.Process = IntPtr.Zero;
            return unchecked((int)exit);
        }
        catch (OperationCanceledException) { return 130; }
        finally
        {
            try
            {
                if (child.Thread != IntPtr.Zero) { CloseHandle(child.Thread); child.Thread = IntPtr.Zero; }
                if (child.Process != IntPtr.Zero) { CloseHandle(child.Process); child.Process = IntPtr.Zero; }
                if (attempted)
                {
                    try { StopAndJoin(job); }
                    catch (NexaConnectorBootstrapQuiescenceException) { throw; }
                    catch { throw new NexaConnectorBootstrapQuiescenceException(); }
                }
            }
            finally
            {
                Console.CancelKeyPress -= cancel;
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (inherited != IntPtr.Zero) Marshal.FreeHGlobal(inherited);
                if (assignedJobs != IntPtr.Zero) Marshal.FreeHGlobal(assignedJobs);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                if (input != null) input.Dispose();
                if (output != null) output.Dispose();
                if (error != null) error.Dispose();
                if (job != null) job.Dispose();
            }
        }
    }

    internal static string Quote(string value)
    {
        if (value == null || value.IndexOf('\0') >= 0 || value.Length > 32766) throw Invalid();
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', checked(slashes * 2 + 1));
            else result.Append('\\', slashes);
            result.Append(character);
            slashes = 0;
        }
        result.Append('\\', checked(slashes * 2)).Append('"');
        return result.ToString();
    }

    internal static string EnvironmentBlock(IDictionary values)
    {
        SortedDictionary<string, string> selected = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        int entries = 0, characters = 0;
        foreach (DictionaryEntry entry in values)
        {
            if (++entries > 4096) throw Invalid();
            string name = entry.Key as string, value = entry.Value as string;
            bool drive = name != null && name.Length == 3 && name[0] == '=' && Char.IsLetter(name[1]) && name[2] == ':';
            if (String.IsNullOrEmpty(name) || (!drive && name.IndexOf('=') >= 0) || name.IndexOf('\0') >= 0 || value == null || value.IndexOf('\0') >= 0) throw Invalid();
            if (name.Length > 32766 || value.Length > 32766) throw Invalid();
            if (name.Equals("NODE_OPTIONS", StringComparison.OrdinalIgnoreCase) || name.Equals("NODE_PATH", StringComparison.OrdinalIgnoreCase) || name.Equals("NODE_EXTRA_CA_CERTS", StringComparison.OrdinalIgnoreCase) || name.Equals("NODE_REPL_EXTERNAL_MODULE", StringComparison.OrdinalIgnoreCase) || name.Equals("NODE_V8_COVERAGE", StringComparison.OrdinalIgnoreCase)) continue;
            characters = checked(characters + name.Length + value.Length + 2);
            if (characters > 262144) throw Invalid();
            selected[name] = value;
        }
        selected["NODE_TLS_REJECT_UNAUTHORIZED"] = "1";
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> entry in selected)
        {
            if (entry.Key.Length > 32766 || entry.Value.Length > 32766 || block.Length + entry.Key.Length + entry.Value.Length + 2 > 262144) throw Invalid();
            block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        }
        return block.Append('\0').ToString();
    }

    private static bool Canonical(string path)
    {
        return path != null && path.Length >= 3 && path.Length <= 4096 && path.IndexOf('\0') < 0 && Char.IsLetter(path[0]) && path[1] == ':' && path[2] == '\\' && String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase);
    }

    private static SafeFileHandle DuplicateStandard(int number)
    {
        IntPtr handle = GetStdHandle(number), self = GetCurrentProcess();
        SafeFileHandle duplicate;
        if (handle == IntPtr.Zero || handle == new IntPtr(-1) || !DuplicateHandle(self, handle, self, out duplicate, 0, true, 2)) throw Invalid();
        return duplicate;
    }

    private static void StopAndJoin(SafeFileHandle job)
    {
        if (!TerminateJobObject(job, 74)) throw new NexaConnectorBootstrapQuiescenceException();
        Stopwatch deadline = Stopwatch.StartNew();
        while (true)
        {
            JobAccounting accounting;
            uint bytes;
            if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JobAccounting)), out bytes) || bytes != Marshal.SizeOf(typeof(JobAccounting))) throw new NexaConnectorBootstrapQuiescenceException();
            if (accounting.ActiveProcesses == 0) return;
            if (deadline.ElapsedMilliseconds >= 10000) throw new NexaConnectorBootstrapQuiescenceException();
            Thread.Sleep(10);
        }
    }

    private static InvalidOperationException Invalid() { return new InvalidOperationException("bootstrap-process-unavailable"); }

    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct Startup { internal int Size; internal string Reserved, Desktop, Title; internal uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags; internal ushort Show, ReservedSize; internal IntPtr ReservedBytes, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] private struct StartupEx { internal Startup Startup; internal IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct JobBasicLimits { internal long ProcessTime, JobTime; internal uint Flags; internal UIntPtr MinimumWorkingSet, MaximumWorkingSet; internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct JobLimits { internal JobBasicLimits Basic; internal IoCounters Io; internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] private struct JobAccounting { internal long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime; internal uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref JobLimits limits, uint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out JobAccounting result, uint bytes, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateJobObject(SafeFileHandle job, uint exit);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out SafeFileHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr bytes, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInformation child);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsProcessInJob(IntPtr process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exit);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
