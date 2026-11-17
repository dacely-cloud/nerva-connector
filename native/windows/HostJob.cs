// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>A failed shutdown never becomes proof that the owned process tree is empty.</summary>
internal sealed class NexaConnectorHostJobUnconfirmedException : Exception
{
    internal NexaConnectorHostJobUnconfirmedException()
        : base("host-job-quiescence-unconfirmed") { }
}

/// <summary>A failed CreateProcess preserves its immediate Win32 code; only a separate empty-job observation proves rejection.</summary>
internal sealed class NexaConnectorHostCreateException : InvalidOperationException
{
    internal readonly uint NativeError;

    internal NexaConnectorHostCreateException(uint error)
        : base("host-process-create-failed")
    {
        NativeError = error;
    }

    internal string ErrorCode
    {
        get { return Classify(NativeError); }
    }

    internal static string Classify(uint error)
    {
        switch (error)
        {
            case 2:
            case 3:
            case 126:
                return "not-found";
            case 5:
            case 577:
            case 740:
                return "permission-denied";
            case 8:
            case 14:
            case 1450:
            case 1816:
                return "resource-limit";
            case 50:
            case 120:
            case 193:
            case 216:
            case 1150:
                return "unsupported";
            case 10:
            case 206:
                return "invalid-request";
            case 267:
                return "not-directory";
            case 1223:
                return "canceled";
            default:
                return "operation-failed";
        }
    }
}

/// <summary>One serialized owner launches a root inside its job before code executes and observes actual job emptiness.</summary>
internal sealed partial class NexaConnectorHostJob : IDisposable
{
    private static readonly char[] QuotedCharacters = { ' ', '\t', '\n', '\v', '"' };
    private SafeFileHandle job;
    private IntPtr process;
    private IntPtr thread;
    private bool launched;
    private bool stopped;
    private bool empty;
    private bool rootExited;
    private bool closed;
    private bool rootCreated;
    private uint rootExit;

    internal NexaConnectorHostJob()
    {
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == null || job.IsInvalid)
        {
            throw Invalid();
        }
        JobLimits limits = new JobLimits { Basic = new JobBasicLimits { Flags = 0x2000 } };
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))))
        {
            job.Dispose();
            throw Invalid();
        }
    }

    /// <summary>The caller owns pipe/ConPTY handles and environment storage through this call; all job calls share one owner thread. A ConPTY root receives explicit null standard handles so Windows cannot substitute the broker's redirected pipes for its pseudoconsole.</summary>
    internal void Launch(
        string executable,
        StringBuilder command,
        string directory,
        IntPtr environment,
        SafeFileHandle[] inheritedHandles,
        IntPtr pseudoConsole,
        CancellationToken cancellation = default(CancellationToken)
    )
    {
        if (
            closed
            || launched
            || stopped
            || command == null
            || command.Length < 1
            || command.Length > 32766
            || command.ToString().IndexOf('\0') >= 0
            || inheritedHandles == null
        )
        {
            throw Invalid();
        }
        bool terminal = pseudoConsole != IntPtr.Zero;
        if (pseudoConsole == new IntPtr(-1) || inheritedHandles.Length != (terminal ? 0 : 3))
        {
            throw Invalid();
        }
        foreach (SafeFileHandle handle in inheritedHandles)
        {
            if (handle == null || handle.IsInvalid || handle.IsClosed)
            {
                throw Invalid();
            }
        }
        if (
            (executable != null && (executable.Length > 4096 || executable.IndexOf('\0') >= 0))
            || (directory != null && (directory.Length > 4096 || directory.IndexOf('\0') >= 0))
        )
        {
            throw Invalid();
        }
        IntPtr attributes = IntPtr.Zero;
        IntPtr handles = IntPtr.Zero;
        IntPtr jobs = IntPtr.Zero;
        bool initialized = false;
        try
        {
            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == UIntPtr.Zero || size.ToUInt64() > 1048576)
            {
                throw Invalid();
            }
            attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size))
            {
                throw Invalid();
            }
            initialized = true;
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, job.DangerousGetHandle());
            if (
                !UpdateProcThreadAttribute(
                    attributes,
                    0,
                    new IntPtr(0x2000D),
                    jobs,
                    new UIntPtr((uint)IntPtr.Size),
                    IntPtr.Zero,
                    IntPtr.Zero
                )
            )
            {
                throw Invalid();
            }
            StartupEx startup = new StartupEx { Attributes = attributes };
            startup.Startup.Size = Marshal.SizeOf(typeof(StartupEx));
            if (terminal)
            {
                if (
                    !UpdateProcThreadAttribute(
                        attributes,
                        0,
                        new IntPtr(0x20016),
                        pseudoConsole,
                        new UIntPtr((uint)IntPtr.Size),
                        IntPtr.Zero,
                        IntPtr.Zero
                    )
                )
                {
                    throw Invalid();
                }
                startup.Startup.Flags = 0x100;
            }
            else
            {
                handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
                for (int index = 0; index < inheritedHandles.Length; index++)
                {
                    Marshal.WriteIntPtr(
                        handles,
                        index * IntPtr.Size,
                        inheritedHandles[index].DangerousGetHandle()
                    );
                }
                if (
                    !UpdateProcThreadAttribute(
                        attributes,
                        0,
                        new IntPtr(0x20002),
                        handles,
                        new UIntPtr((uint)(3 * IntPtr.Size)),
                        IntPtr.Zero,
                        IntPtr.Zero
                    )
                )
                {
                    throw Invalid();
                }
                startup.Startup.Flags = 0x100;
                startup.Startup.Input = inheritedHandles[0].DangerousGetHandle();
                startup.Startup.Output = inheritedHandles[1].DangerousGetHandle();
                startup.Startup.Error = inheritedHandles[2].DangerousGetHandle();
            }
            cancellation.ThrowIfCancellationRequested();
            launched = true;
            empty = false;
            ProcessInformation child;
            bool created = CreateProcessW(
                executable,
                command,
                IntPtr.Zero,
                IntPtr.Zero,
                !terminal,
                0x80404,
                environment,
                directory,
                ref startup,
                out child
            );
            uint createError = created ? 0 : unchecked((uint)Marshal.GetLastWin32Error());
            process = child.Process;
            thread = child.Thread;
            rootCreated = created;
            if (!created)
            {
                throw new NexaConnectorHostCreateException(createError);
            }
            bool member;
            if (!IsProcessInJob(process, job, out member) || !member)
            {
                throw Invalid();
            }
            cancellation.ThrowIfCancellationRequested();
            if (ResumeThread(thread) != 1)
            {
                throw Invalid();
            }
        }
        catch
        {
            CloseThread();
            StopAndJoin();
            throw;
        }
        finally
        {
            CloseThread();
            if (initialized)
            {
                DeleteProcThreadAttributeList(attributes);
            }
            if (attributes != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(attributes);
            }
            if (handles != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(handles);
            }
            if (jobs != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(jobs);
            }
            GC.KeepAlive(inheritedHandles);
        }
    }

    /// <summary>A failed CreateProcess with no root admits no user output or process-tree effects.</summary>
    internal bool RootCreated
    {
        get { return rootCreated; }
    }

    /// <summary>The root's exit code remains independent from descendants; the handle closes before subsequent job-count observations.</summary>
    internal bool TryRootExit(out uint exit)
    {
        if (closed)
        {
            throw Invalid();
        }
        if (!rootExited && process != IntPtr.Zero)
        {
            uint waited = WaitForSingleObject(process, 0);
            if (waited == 0)
            {
                if (!GetExitCodeProcess(process, out rootExit))
                {
                    throw new NexaConnectorHostJobUnconfirmedException();
                }
                CloseHandle(process);
                process = IntPtr.Zero;
                rootExited = true;
            }
            else if (waited != 258)
            {
                throw new NexaConnectorHostJobUnconfirmedException();
            }
        }
        exit = rootExit;
        return rootExited;
    }

    /// <summary>False is an observed empty job whose created root exit is also observed, never a substitute for pipe EOF or a termination request.</summary>
    internal bool TreeRunning
    {
        get
        {
            if (closed)
            {
                throw Invalid();
            }
            empty = Quiescent();
            return !empty;
        }
    }

    /// <summary>Cancellation terminates the owned job and joins an actual zero count; failure retains this owner for explicit recovery.</summary>
    internal void StopAndJoin()
    {
        if (closed)
        {
            return;
        }
        try
        {
            stopped = true;
            CloseThread();
            if (!TerminateJobObject(job, 74))
            {
                throw new NexaConnectorHostJobUnconfirmedException();
            }
            Stopwatch deadline = Stopwatch.StartNew();
            while (true)
            {
                if (Quiescent())
                {
                    empty = true;
                    return;
                }
                if (deadline.ElapsedMilliseconds >= 10000)
                {
                    throw new NexaConnectorHostJobUnconfirmedException();
                }
                Thread.Sleep(10);
            }
        }
        catch (NexaConnectorHostJobUnconfirmedException)
        {
            throw;
        }
        catch
        {
            throw new NexaConnectorHostJobUnconfirmedException();
        }
    }

    /// <summary>Disposal succeeds only after confirmed quiescence; callers must retain an owner whose shutdown fails.</summary>
    public void Dispose()
    {
        if (closed)
        {
            return;
        }
        if (!empty)
        {
            StopAndJoin();
        }
        if (process != IntPtr.Zero)
        {
            CloseHandle(process);
            process = IntPtr.Zero;
        }
        CloseThread();
        job.Dispose();
        closed = true;
    }

    /// <summary>Windows argument quoting preserves literal quotes and trailing backslashes without a shell; text that needs no quotes stays verbatim for non-CRT parsers such as cmd.exe.</summary>
    internal static string Quote(string value)
    {
        if (value == null || value.Length > 32766 || value.IndexOf('\0') >= 0)
        {
            throw Invalid();
        }
        if (value.Length != 0 && value.IndexOfAny(QuotedCharacters) < 0)
        {
            return value;
        }
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', checked(slashes * 2 + 1)).Append('"');
            }
            else
            {
                quoted.Append('\\', slashes).Append(character);
            }
            slashes = 0;
        }
        return quoted.Append('\\', checked(slashes * 2)).Append('"').ToString();
    }

    /// <summary>A zero Job count can precede the signaled root handle; quiescence also requires the created root's observed exit.</summary>
    private bool Quiescent()
    {
        uint ignored;
        bool exited = TryRootExit(out ignored);
        return ActiveProcesses() == 0 && (exited || process == IntPtr.Zero);
    }

    private uint ActiveProcesses()
    {
        JobAccounting accounting;
        uint bytes;
        if (
            !QueryInformationJobObject(
                job,
                1,
                out accounting,
                (uint)Marshal.SizeOf(typeof(JobAccounting)),
                out bytes
            )
            || bytes != Marshal.SizeOf(typeof(JobAccounting))
        )
        {
            throw new NexaConnectorHostJobUnconfirmedException();
        }
        return accounting.ActiveProcesses;
    }

    private void CloseThread()
    {
        if (thread != IntPtr.Zero)
        {
            CloseHandle(thread);
            thread = IntPtr.Zero;
        }
    }

    private static InvalidOperationException Invalid()
    {
        return new InvalidOperationException("host-job-unavailable");
    }
}
