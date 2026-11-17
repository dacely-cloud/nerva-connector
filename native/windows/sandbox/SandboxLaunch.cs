// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>One restricted child; suspended token/job verification precedes all customer-code execution.</summary>
internal sealed class SandboxLaunch : IDisposable
{
    private SafeFileHandle job, reader;
    private IntPtr process;

    internal SandboxLaunch(SandboxFixture fixture, SandboxPath image, SandboxWorkerMode mode, int port)
    {
        SafeFileHandle input = null, excluded = null, writer = null;
        IntPtr environment = IntPtr.Zero;
        SandboxNative.ProcessInformation child = new SandboxNative.ProcessInformation();
        try
        {
            long position;
            if (!SandboxNative.SetFilePointerEx(fixture.Allowed, 0, out position, 0) || position != 0) throw new InvalidOperationException("canary-position");
            IntPtr self = SandboxNative.GetCurrentProcess();
            if (!SandboxNative.DuplicateHandle(self, fixture.Allowed, self, out input, 0x00120089, true, 0) || !SandboxNative.DuplicateHandle(self, fixture.Excluded, self, out excluded, 0x00120089, true, 0)) throw new InvalidOperationException("handle-duplicate");
            SandboxNative.SecurityAttributes security = new SandboxNative.SecurityAttributes { Length = Marshal.SizeOf(typeof(SandboxNative.SecurityAttributes)), Inherit = true };
            if (!SandboxNative.CreatePipe(out reader, out writer, ref security, 4096) || !SandboxNative.SetHandleInformation(reader, 1, 0)) throw new InvalidOperationException("pipe");
            job = SandboxNative.CreateJobObjectW(IntPtr.Zero, null);
            if (job == null || job.IsInvalid) throw new InvalidOperationException("job-create");
            SandboxNative.JobLimits limits = new SandboxNative.JobLimits { Basic = new SandboxNative.JobBasicLimits { ProcessTime = SandboxPolicy.CpuTicks, JobTime = SandboxPolicy.CpuTicks, Flags = SandboxPolicy.JobFlags, ActiveProcesses = 1 }, ProcessMemory = new UIntPtr(SandboxPolicy.MemoryBytes), JobMemory = new UIntPtr(SandboxPolicy.MemoryBytes) };
            if (!SandboxNative.SetInformationJobObject(job, SandboxJobInformation.ExtendedLimits, ref limits, (uint)Marshal.SizeOf(typeof(SandboxNative.JobLimits)))) throw new InvalidOperationException("job-limits");
            SandboxNative.JobLimits actual;
            if (!SandboxNative.QueryInformationJobObject(job, SandboxJobInformation.ExtendedLimits, out actual, (uint)Marshal.SizeOf(typeof(SandboxNative.JobLimits)), IntPtr.Zero) || actual.Basic.Flags != limits.Basic.Flags || actual.Basic.ActiveProcesses != 1 || actual.Basic.ProcessTime != limits.Basic.ProcessTime || actual.Basic.JobTime != limits.Basic.JobTime || actual.ProcessMemory != limits.ProcessMemory || actual.JobMemory != limits.JobMemory) throw new InvalidOperationException("job-verify");
            string command = SandboxPolicy.Quote(image.Path) + (mode == SandboxWorkerMode.Probe ? " --probe " : " --wait ") + SandboxPolicy.Quote(fixture.PackageSid);
            if (mode == SandboxWorkerMode.Probe) command += " " + input.DangerousGetHandle().ToInt64().ToString(CultureInfo.InvariantCulture) + " " + excluded.DangerousGetHandle().ToInt64().ToString(CultureInfo.InvariantCulture) + " " + fixture.Nonce + " " + SandboxPolicy.Quote(fixture.Root + "\\blocked.bin") + " " + port.ToString(CultureInfo.InvariantCulture);
            char[] windows = new char[4096];
            uint windowsLength = SandboxNative.GetSystemWindowsDirectoryW(windows, (uint)windows.Length);
            if (windowsLength == 0 || windowsLength >= windows.Length) throw new InvalidOperationException("system-directory");
            string systemRoot = new string(windows, 0, (int)windowsLength);
            environment = Marshal.StringToHGlobalUni("LOCALAPPDATA=" + fixture.ProfilePath + "\0PATH=" + systemRoot + "\\System32\0SystemRoot=" + systemRoot + "\0TEMP=" + fixture.ProfilePath + "\0TMP=" + fixture.ProfilePath + "\0WINDIR=" + systemRoot + "\0\0");
            SandboxImageIdentity originalImage = SandboxImage.Capture(image.Last);
            using (SandboxAttributes attributes = new SandboxAttributes(fixture.Package, input.DangerousGetHandle(), writer.DangerousGetHandle()))
            {
                SandboxNative.StartupEx startup = new SandboxNative.StartupEx { Attributes = attributes.List };
                startup.Startup.Size = Marshal.SizeOf(typeof(SandboxNative.StartupEx)); startup.Startup.Flags = 0x100;
                startup.Startup.Input = input.DangerousGetHandle(); startup.Startup.Output = writer.DangerousGetHandle(); startup.Startup.Error = writer.DangerousGetHandle();
                if (!SandboxNative.CreateProcessW(image.Path, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, SandboxPolicy.CreationFlags, environment, fixture.ProfilePath, ref startup, out child)) throw new InvalidOperationException("lpac-launch");
                process = child.Process;
                if (!SandboxNative.AssignProcessToJobObject(job, process)) throw new InvalidOperationException("job-assign");
                bool assigned;
                if (!SandboxNative.IsProcessInJob(process, job, out assigned) || !assigned) throw new InvalidOperationException("job-membership");
                SandboxToken.Verify(process, fixture.PackageSid);
                SandboxImage.Verify(process, image, originalImage);
                if (SandboxNative.ResumeThread(child.Thread) != 1) throw new InvalidOperationException("resume");
                GC.KeepAlive(image); GC.KeepAlive(fixture);
            }
        }
        catch { Dispose(); throw; }
        finally
        {
            if (child.Thread != IntPtr.Zero) SandboxNative.CloseHandle(child.Thread);
            if (input != null) input.Dispose(); if (excluded != null) excluded.Dispose(); if (writer != null) writer.Dispose();
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }

    internal string Finish()
    {
        if (SandboxNative.WaitForSingleObject(process, SandboxPolicy.WallMilliseconds) != 0) throw new InvalidOperationException("worker-deadline");
        uint exit;
        if (!SandboxNative.GetExitCodeProcess(process, out exit) || exit != 0) throw new InvalidOperationException("worker-refused");
        return ReadReport();
    }

    internal void ProveKillOnClose()
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        while (true)
        {
            uint available;
            if (!SandboxNative.PeekNamedPipe(reader, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero)) throw new InvalidOperationException("wait-pipe");
            if (available != 0) break;
            if (elapsed.ElapsedMilliseconds >= SandboxPolicy.WallMilliseconds || SandboxNative.WaitForSingleObject(process, 0) != 258) throw new InvalidOperationException("wait-worker");
            Thread.Sleep(10);
        }
        if (ReadReport() != "NEXA_SANDBOX_WAIT_V1\n" || SandboxNative.WaitForSingleObject(process, 0) != 258) throw new InvalidOperationException("wait-report");
        job.Dispose(); job = null;
        if (SandboxNative.WaitForSingleObject(process, 2000) != 0) throw new InvalidOperationException("job-close-did-not-kill");
    }

    private string ReadReport()
    {
        uint available;
        if (!SandboxNative.PeekNamedPipe(reader, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero) || available == 0 || available > SandboxPolicy.MaximumReport) throw new InvalidOperationException("report-size");
        byte[] bytes = new byte[available]; uint read;
        if (!SandboxNative.ReadFile(reader, bytes, available, out read, IntPtr.Zero) || read != available) throw new InvalidOperationException("report-read");
        return Encoding.ASCII.GetString(bytes);
    }

    public void Dispose()
    {
        bool joined = true;
        if (process != IntPtr.Zero)
        {
            if (SandboxNative.WaitForSingleObject(process, 0) != 0)
            {
                if (job != null) SandboxNative.TerminateJobObject(job, 73);
                SandboxNative.TerminateProcess(process, 73);
                joined = SandboxNative.WaitForSingleObject(process, 2000) == 0;
            }
            SandboxNative.CloseHandle(process); process = IntPtr.Zero;
        }
        if (job != null) { job.Dispose(); job = null; }
        if (reader != null) { reader.Dispose(); reader = null; }
        if (!joined) throw new InvalidOperationException("worker-join");
    }
}
