// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>A ConPTY pump owns its stream pair and cancels only its exact synchronous I/O thread.</summary>
internal sealed partial class NexaConnectorHostTerminalConsole : IDisposable
{
    /// <summary>Cancellation interrupts a synchronous OS operation through its exact owned thread handle.</summary>
    private sealed class Pump
    {
        private readonly Stream source;
        private readonly Stream destination;
        private readonly Action<long> accepted;
        private readonly Action<bool, long> completed;
        private readonly Action failed;
        private readonly bool output;
        private readonly ManualResetEvent started = new ManualResetEvent(false);
        private readonly object gate = new object();
        private SafeFileHandle nativeThread;
        private Thread thread;
        private int stopping;
        private int discard;
        private bool delivered = true;
        private bool finished;

        internal Pump(
            Stream source,
            Stream destination,
            Action<long> accepted,
            Action<bool, long> completed,
            Action failed,
            bool output
        )
        {
            this.source = source;
            this.destination = destination;
            this.accepted = accepted;
            this.completed = completed;
            this.failed = failed;
            this.output = output;
        }

        internal void Start()
        {
            thread = new Thread(Copy);
            thread.IsBackground = true;
            thread.Start();
            if (!started.WaitOne(5000))
            {
                throw new IOException("terminal-pump-start");
            }
            lock (gate)
            {
                if (nativeThread == null || nativeThread.IsInvalid)
                {
                    throw new IOException("terminal-pump-start");
                }
            }
        }

        private void Copy()
        {
            long total = 0;
            bool eof = false;
            byte[] bytes = new byte[32768];
            try
            {
                lock (gate)
                {
                    nativeThread = OpenThread(1, false, GetCurrentThreadId());
                    if (nativeThread == null || nativeThread.IsInvalid)
                    {
                        throw new IOException("terminal-pump-thread");
                    }
                }
                started.Set();
                while (Interlocked.CompareExchange(ref stopping, 0, 0) == 0)
                {
                    int count;
                    try
                    {
                        count = source.Read(bytes, 0, bytes.Length);
                    }
                    catch (IOException error)
                    {
                        int code = error.HResult & 65535;
                        if (output && (code == 109 || code == 232))
                        {
                            eof = true;
                            break;
                        }
                        if (
                            output
                            && code == 995
                            && Interlocked.CompareExchange(ref discard, 0, 0) != 0
                        )
                        {
                            continue;
                        }
                        throw;
                    }
                    if (count == 0)
                    {
                        eof = true;
                        break;
                    }
                    if (Interlocked.CompareExchange(ref stopping, 0, 0) != 0)
                    {
                        break;
                    }
                    if (Interlocked.CompareExchange(ref discard, 0, 0) != 0)
                    {
                        delivered = false;
                        continue;
                    }
                    try
                    {
                        destination.Write(bytes, 0, count);
                        destination.Flush();
                    }
                    catch (IOException)
                    {
                        if (output && Interlocked.CompareExchange(ref discard, 0, 0) != 0)
                        {
                            delivered = false;
                            continue;
                        }
                        throw;
                    }
                    total = checked(total + count);
                    if (accepted != null)
                    {
                        accepted(total);
                    }
                }
            }
            catch (Exception)
            {
                delivered = false;
                if (Interlocked.CompareExchange(ref stopping, 0, 0) == 0)
                {
                    failed();
                }
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
                started.Set();
                if (completed != null)
                {
                    completed(eof && delivered, total);
                }
                if (!output && eof && Interlocked.CompareExchange(ref stopping, 0, 0) == 0)
                {
                    failed();
                }
            }
        }

        internal void DrainOnly()
        {
            Interlocked.Exchange(ref discard, 1);
            Interrupt();
        }

        internal void Stop()
        {
            Interlocked.Exchange(ref stopping, 1);
            Stopwatch deadline = Stopwatch.StartNew();
            while (thread != null && thread.IsAlive)
            {
                Interrupt();
                if (thread.Join(20))
                {
                    break;
                }
                if (deadline.ElapsedMilliseconds >= 3000)
                {
                    throw new IOException("terminal-pump-close-unconfirmed");
                }
            }
            Finish();
        }

        internal void Finish()
        {
            if (finished)
            {
                return;
            }
            if (thread != null && !thread.Join(3000))
            {
                throw new IOException("terminal-pump-close-unconfirmed");
            }
            source.Dispose();
            destination.Dispose();
            lock (gate)
            {
                if (nativeThread != null)
                {
                    nativeThread.Dispose();
                }
                nativeThread = null;
            }
            started.Dispose();
            finished = true;
        }

        private void Interrupt()
        {
            lock (gate)
            {
                if (nativeThread != null && !nativeThread.IsInvalid && !nativeThread.IsClosed)
                {
                    CancelSynchronousIo(nativeThread);
                }
            }
        }
    }
}
