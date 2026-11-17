// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

/// <summary>Artifact streams borrow pinned handles and enforce bounded complete native reads and writes.</summary>
public static partial class NexaConnectorStateOwner
{
    private sealed class ArtifactHandleStream : Stream
    {
        private readonly SafeFileHandle handle;
        private readonly bool writable;

        internal ArtifactHandleStream(SafeFileHandle file, bool writing)
        {
            handle = file;
            writable = writing;
        }

        public override bool CanRead
        {
            get { return !writable; }
        }
        public override bool CanSeek
        {
            get { return false; }
        }
        public override bool CanWrite
        {
            get { return writable; }
        }
        public override long Length
        {
            get { throw new NotSupportedException(); }
        }
        public override long Position
        {
            get { throw new NotSupportedException(); }
            set { throw new NotSupportedException(); }
        }

        public override void Flush()
        {
            if (writable && !Native.FlushFileBuffers(handle))
            {
                throw LastError();
            }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (writable || offset != 0 || count < 0 || count > buffer.Length)
            {
                throw new Failure("invalid");
            }
            uint read;
            if (!Native.ReadFile(handle, buffer, (uint)count, out read, IntPtr.Zero))
            {
                throw LastError();
            }
            return checked((int)read);
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            if (!writable || offset < 0 || count < 0 || offset > buffer.Length - count)
            {
                throw new Failure("invalid");
            }
            GCHandle pinned = GCHandle.Alloc(buffer, GCHandleType.Pinned);
            try
            {
                int written = 0;
                while (written < count)
                {
                    uint part;
                    if (
                        !WriteArtifactBytes(
                            handle,
                            IntPtr.Add(pinned.AddrOfPinnedObject(), offset + written),
                            (uint)(count - written),
                            out part,
                            IntPtr.Zero
                        )
                        || part == 0
                        || part > count - written
                    )
                    {
                        throw LastError();
                    }
                    written += checked((int)part);
                }
            }
            finally
            {
                pinned.Free();
            }
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            throw new NotSupportedException();
        }

        public override void SetLength(long value)
        {
            throw new NotSupportedException();
        }
    }

    [DllImport("kernel32.dll", EntryPoint = "WriteFile", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteArtifactBytes(
        SafeFileHandle file,
        IntPtr bytes,
        uint count,
        out uint written,
        IntPtr overlap
    );
}
