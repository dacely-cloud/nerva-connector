// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>Host control and output pumps retain explicit cancellation and completion ownership.</summary>
public static partial class NexaConnectorHostProcess
{
    private sealed class HostControl : IDisposable
    {
        private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        private readonly AutoResetEvent wake = new AutoResetEvent(false);
        private int requested;
        internal volatile bool Disconnected;
        internal bool Stopping
        {
            get { return cancellation.IsCancellationRequested; }
        }
        internal CancellationToken Cancellation
        {
            get { return cancellation.Token; }
        }

        internal HostControl(TextReader reader, string token)
        {
            Thread monitor = new Thread(
                delegate()
                {
                    try
                    {
                        while (true)
                        {
                            if (ReadControl(reader, token) != "stop")
                            {
                                throw new InvalidOperationException("host-control-operation");
                            }
                            Signal();
                        }
                    }
                    catch
                    {
                        Disconnected = true;
                        Signal();
                    }
                }
            );
            monitor.IsBackground = true;
            monitor.Start();
        }

        private void Signal()
        {
            Interlocked.Exchange(ref requested, 1);
            try
            {
                cancellation.Cancel();
                wake.Set();
            }
            catch (ObjectDisposedException) { }
        }

        internal bool TakeStop()
        {
            return Interlocked.Exchange(ref requested, 0) != 0;
        }

        internal void Wait(int milliseconds)
        {
            wake.WaitOne(milliseconds);
        }

        public void Dispose()
        {
            cancellation.Dispose();
            wake.Dispose();
        }
    }

    private sealed class HostOutputPump : IDisposable
    {
        private readonly FileStream reader;
        private readonly Stream destination;
        private readonly ManualResetEvent done = new ManualResetEvent(false);
        private Thread thread;
        internal long Bytes;
        private bool complete;
        internal bool Complete
        {
            get { return done.WaitOne(0) && complete; }
        }

        internal HostOutputPump(SafeFileHandle handle, Stream output)
        {
            reader = new FileStream(handle, FileAccess.Read, 65536, false);
            destination = output;
        }

        internal void Start()
        {
            thread = new Thread(Copy);
            thread.IsBackground = true;
            thread.Start();
        }

        private void Copy()
        {
            try
            {
                byte[] bytes = new byte[65536];
                while (true)
                {
                    int count = reader.Read(bytes, 0, bytes.Length);
                    if (count == 0)
                    {
                        break;
                    }
                    destination.Write(bytes, 0, count);
                    Bytes = checked(Bytes + count);
                }
                destination.Flush();
                complete = true;
            }
            catch (IOException) { }
            catch (OverflowException) { }
            catch (ObjectDisposedException) { }
            finally
            {
                done.Set();
            }
        }

        internal void Wait(int milliseconds)
        {
            done.WaitOne(milliseconds);
        }

        public void Dispose()
        {
            reader.Dispose();
            if (thread == null || thread.Join(2000))
            {
                done.Dispose();
            }
        }
    }
}
