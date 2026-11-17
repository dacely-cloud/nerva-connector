// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>One ConPTY owns fixed-size synchronous pumps; output keeps draining while the console closes.</summary>
internal sealed class NexaConnectorHostTerminalConsole : IDisposable
{
    private SafeFileHandle inputRead, outputWrite;
    private FileStream inputWrite;
    private readonly Pump output;
    private Pump input;
    private IntPtr console;
    private bool disposed;
    private Thread closer;
    private Exception closeFailure;

    internal NexaConnectorHostTerminalConsole(short cols, short rows, bool probe, Action<bool, long> completed, Action failed)
    {
        SafeFileHandle inputWriter = null, outputReader = null;
        FileStream reader = null;
        Stream destination = null;
        try
        {
            if (!CreatePipe(out inputRead, out inputWriter, IntPtr.Zero, 32768) || !CreatePipe(out outputReader, out outputWrite, IntPtr.Zero, 32768)) throw new IOException("terminal-pipes");
            inputWrite = new FileStream(inputWriter, FileAccess.Write, 32768, false); inputWriter = null;
            reader = new FileStream(outputReader, FileAccess.Read, 32768, false); outputReader = null;
            destination = probe ? Stream.Null : Standard(-11, FileAccess.Write);
            output = new Pump(reader, destination, null, completed, failed, true);
            reader = null; destination = null;
            output.Start();
            int result = CreatePseudoConsole(new Coordinate { X = cols, Y = rows }, inputRead, outputWrite, 0, out console);
            if (result != 0 || console == IntPtr.Zero) throw new NotSupportedException("terminal-conpty-unavailable");
        }
        catch { if (inputWriter != null) inputWriter.Dispose(); if (outputReader != null) outputReader.Dispose(); if (reader != null) reader.Dispose(); if (destination != null) destination.Dispose(); Dispose(); throw; }
    }

    internal IntPtr Handle { get { return console; } }

    internal void StartInput(Action<long> accepted, Action failed)
    {
        inputRead.Dispose(); inputRead = null;
        outputWrite.Dispose(); outputWrite = null;
        input = new Pump(Standard(-10, FileAccess.Read), inputWrite, accepted, null, failed, false);
        inputWrite = null;
        input.Start();
    }

    internal void Resize(short cols, short rows)
    {
        if (console == IntPtr.Zero || ResizePseudoConsole(console, new Coordinate { X = cols, Y = rows }) != 0) throw new IOException("terminal-resize");
    }

    internal void AbandonOutput() { if (output != null) output.DrainOnly(); }

    public void Dispose()
    {
        if (disposed) return;
        if (input != null) { input.Stop(); input = null; }
        if (inputWrite != null) { inputWrite.Dispose(); inputWrite = null; }
        if (inputRead != null) { inputRead.Dispose(); inputRead = null; }
        if (outputWrite != null) { outputWrite.Dispose(); outputWrite = null; }
        if (console != IntPtr.Zero)
        {
            IntPtr closing = console; console = IntPtr.Zero;
            closer = new Thread(delegate() { try { ClosePseudoConsole(closing); } catch (Exception error) { closeFailure = error; } });
            closer.IsBackground = true;
            closer.Start();
        }
        if (closer != null)
        {
            if (!closer.Join(8000)) throw new IOException("terminal-console-close-unconfirmed");
            if (closeFailure != null) throw new IOException("terminal-console-close-unconfirmed");
        }
        if (output != null) output.Finish();
        disposed = true;
    }

    private static FileStream Standard(int number, FileAccess access)
    {
        SafeFileHandle duplicate;
        IntPtr process = GetCurrentProcess(), handle = GetStdHandle(number);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1) || !DuplicateHandle(process, handle, process, out duplicate, 0, false, 2)) throw new IOException("terminal-standard-stream");
        return new FileStream(duplicate, access, 32768, false);
    }

    /// <summary>Cancellation interrupts a synchronous OS operation through its exact owned thread handle.</summary>
    private sealed class Pump
    {
        private readonly Stream source, destination;
        private readonly Action<long> accepted;
        private readonly Action<bool, long> completed;
        private readonly Action failed;
        private readonly bool output;
        private readonly ManualResetEvent started = new ManualResetEvent(false);
        private readonly object gate = new object();
        private SafeFileHandle nativeThread;
        private Thread thread;
        private int stopping, discard;
        private bool delivered = true, finished;

        internal Pump(Stream source, Stream destination, Action<long> accepted, Action<bool, long> completed, Action failed, bool output)
        {
            this.source = source; this.destination = destination; this.accepted = accepted; this.completed = completed; this.failed = failed; this.output = output;
        }

        internal void Start() { thread = new Thread(Copy); thread.IsBackground = true; thread.Start(); if (!started.WaitOne(5000)) throw new IOException("terminal-pump-start"); lock (gate) if (nativeThread == null || nativeThread.IsInvalid) throw new IOException("terminal-pump-start"); }

        private void Copy()
        {
            long total = 0;
            bool eof = false;
            byte[] bytes = new byte[32768];
            try
            {
                lock (gate) { nativeThread = OpenThread(1, false, GetCurrentThreadId()); if (nativeThread == null || nativeThread.IsInvalid) throw new IOException("terminal-pump-thread"); }
                started.Set();
                while (Interlocked.CompareExchange(ref stopping, 0, 0) == 0)
                {
                    int count;
                    try { count = source.Read(bytes, 0, bytes.Length); }
                    catch (IOException error) { int code = error.HResult & 65535; if (output && (code == 109 || code == 232)) { eof = true; break; } if (output && code == 995 && Interlocked.CompareExchange(ref discard, 0, 0) != 0) continue; throw; }
                    if (count == 0) { eof = true; break; }
                    if (Interlocked.CompareExchange(ref stopping, 0, 0) != 0) break;
                    if (Interlocked.CompareExchange(ref discard, 0, 0) != 0) { delivered = false; continue; }
                    try { destination.Write(bytes, 0, count); destination.Flush(); }
                    catch (IOException) { if (output && Interlocked.CompareExchange(ref discard, 0, 0) != 0) { delivered = false; continue; } throw; }
                    total = checked(total + count);
                    if (accepted != null) accepted(total);
                }
            }
            catch (Exception) { delivered = false; if (Interlocked.CompareExchange(ref stopping, 0, 0) == 0) failed(); }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
                started.Set();
                if (completed != null) completed(eof && delivered, total);
                if (!output && eof && Interlocked.CompareExchange(ref stopping, 0, 0) == 0) failed();
            }
        }

        internal void DrainOnly() { Interlocked.Exchange(ref discard, 1); Interrupt(); }

        internal void Stop()
        {
            Interlocked.Exchange(ref stopping, 1);
            Stopwatch deadline = Stopwatch.StartNew();
            while (thread != null && thread.IsAlive) { Interrupt(); if (thread.Join(20)) break; if (deadline.ElapsedMilliseconds >= 3000) throw new IOException("terminal-pump-close-unconfirmed"); }
            Finish();
        }

        internal void Finish()
        {
            if (finished) return;
            if (thread != null && !thread.Join(3000)) throw new IOException("terminal-pump-close-unconfirmed");
            source.Dispose(); destination.Dispose();
            lock (gate) { if (nativeThread != null) nativeThread.Dispose(); nativeThread = null; }
            started.Dispose();
            finished = true;
        }

        private void Interrupt() { lock (gate) { if (nativeThread != null && !nativeThread.IsInvalid && !nativeThread.IsClosed) CancelSynchronousIo(nativeThread); } }
    }

    [StructLayout(LayoutKind.Sequential)] private struct Coordinate { internal short X, Y; }
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern int CreatePseudoConsole(Coordinate size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern int ResizePseudoConsole(IntPtr console, Coordinate size);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out SafeFileHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle OpenThread(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint threadId);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CancelSynchronousIo(SafeFileHandle thread);
}
