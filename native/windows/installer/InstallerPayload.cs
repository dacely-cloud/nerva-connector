// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

/// <summary>One file the setup program carries: its plain name, exact size and SHA-256.</summary>
internal sealed class NexaConnectorPayloadFile
{
    internal string Name;
    internal long Size;
    internal byte[] Sha256;
}

/// <summary>
/// Reads the files the setup program carries and writes them to a directory, checking each file's size and SHA-256.
/// </summary>
/// <remarks>
/// Layout, little-endian: the eight ASCII bytes NERVACP1, a UInt16-prefixed UTF-8 version, a UInt16 file count, then
/// per file a UInt16-prefixed UTF-8 name, its UInt64 size, its 32-byte SHA-256, a UInt64 compressed length and that
/// many gzip bytes. script/ConnectorWindowsPayload.ts writes it. Names are single plain file names, so nothing can be
/// written outside the target directory.
/// </remarks>
internal static class NexaConnectorInstallerPayload
{
    internal const string ResourceName = "NexaConnector.Payload";
    private const string Magic = "NERVACP1";
    private const int MaximumFiles = 64;
    private const long MaximumFileBytes = 536870912;

    /// <summary>The payload's version, read from the start of the stream.</summary>
    internal static string ReadVersion(Stream payload)
    {
        BinaryReader reader = new BinaryReader(payload, Encoding.UTF8);
        byte[] magic = reader.ReadBytes(Magic.Length);
        if (Encoding.ASCII.GetString(magic) != Magic)
        {
            throw new InvalidDataException("The setup program is damaged. Download it again.");
        }
        return ReadText(reader, 64);
    }

    /// <summary>Writes every file into <paramref name="directory"/>, reporting progress as files complete.</summary>
    /// <returns>The files written, in payload order.</returns>
    internal static List<NexaConnectorPayloadFile> Extract(
        Stream payload,
        string directory,
        Action<int, int> progress
    )
    {
        BinaryReader reader = new BinaryReader(payload, Encoding.UTF8);
        int count = reader.ReadUInt16();
        if (count < 1 || count > MaximumFiles)
        {
            throw Damaged();
        }
        List<NexaConnectorPayloadFile> files = new List<NexaConnectorPayloadFile>();
        HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < count; index++)
        {
            NexaConnectorPayloadFile file = new NexaConnectorPayloadFile();
            file.Name = ReadText(reader, 128);
            if (!PlainName(file.Name) || !names.Add(file.Name))
            {
                throw Damaged();
            }
            ulong size = reader.ReadUInt64();
            if (size > (ulong)MaximumFileBytes)
            {
                throw Damaged();
            }
            file.Size = (long)size;
            file.Sha256 = reader.ReadBytes(32);
            ulong compressed = reader.ReadUInt64();
            if (file.Sha256.Length != 32 || compressed > (ulong)MaximumFileBytes)
            {
                throw Damaged();
            }
            Write(payload, (long)compressed, Path.Combine(directory, file.Name), file);
            files.Add(file);
            if (progress != null)
            {
                progress(index + 1, count);
            }
        }
        if (payload.ReadByte() != -1)
        {
            throw Damaged();
        }
        return files;
    }

    private static void Write(
        Stream payload,
        long compressed,
        string destination,
        NexaConnectorPayloadFile file
    )
    {
        using (BoundedStream bounded = new BoundedStream(payload, compressed))
        using (GZipStream inflated = new GZipStream(bounded, CompressionMode.Decompress, true))
        using (
            FileStream output = new FileStream(
                destination,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None
            )
        )
        using (SHA256 hash = SHA256.Create())
        {
            byte[] buffer = new byte[81920];
            long written = 0;
            int read;
            while ((read = inflated.Read(buffer, 0, buffer.Length)) > 0)
            {
                written += read;
                if (written > file.Size)
                {
                    throw Damaged();
                }
                hash.TransformBlock(buffer, 0, read, null, 0);
                output.Write(buffer, 0, read);
            }
            hash.TransformFinalBlock(new byte[0], 0, 0);
            if (written != file.Size || !Same(hash.Hash, file.Sha256))
            {
                throw Damaged();
            }
            bounded.Drain();
            output.Flush(true);
        }
    }

    private static string ReadText(BinaryReader reader, int maximum)
    {
        int length = reader.ReadUInt16();
        if (length < 1 || length > maximum)
        {
            throw Damaged();
        }
        byte[] bytes = reader.ReadBytes(length);
        if (bytes.Length != length)
        {
            throw Damaged();
        }
        return new UTF8Encoding(false, true).GetString(bytes);
    }

    private static bool PlainName(string name)
    {
        if (name == "." || name == "..")
        {
            return false;
        }
        foreach (char character in name)
        {
            if (
                !(
                    char.IsLetterOrDigit(character)
                    || character == ' '
                    || character == '.'
                    || character == '-'
                    || character == '_'
                )
            )
            {
                return false;
            }
        }
        return true;
    }

    private static bool Same(byte[] left, byte[] right)
    {
        if (left == null || right == null || left.Length != right.Length)
        {
            return false;
        }
        int difference = 0;
        for (int index = 0; index < left.Length; index++)
        {
            difference |= left[index] ^ right[index];
        }
        return difference == 0;
    }

    private static InvalidDataException Damaged()
    {
        return new InvalidDataException("The setup program is damaged. Download it again.");
    }

    /// <summary>Exposes exactly one file's compressed bytes so the decompressor cannot read into the next file.</summary>
    private sealed class BoundedStream : Stream
    {
        private readonly Stream inner;
        private long remaining;

        internal BoundedStream(Stream inner, long length)
        {
            this.inner = inner;
            remaining = length;
        }

        public override bool CanRead
        {
            get { return true; }
        }
        public override bool CanSeek
        {
            get { return false; }
        }
        public override bool CanWrite
        {
            get { return false; }
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

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (remaining <= 0)
            {
                return 0;
            }
            int read = inner.Read(buffer, offset, (int)Math.Min(count, remaining));
            if (read <= 0)
            {
                throw Damaged();
            }
            remaining -= read;
            return read;
        }

        /// <summary>Skips any trailing compressed bytes the decompressor did not consume.</summary>
        internal void Drain()
        {
            byte[] buffer = new byte[4096];
            while (remaining > 0)
            {
                Read(buffer, 0, buffer.Length);
            }
        }

        public override void Flush() { }

        public override long Seek(long offset, SeekOrigin origin)
        {
            throw new NotSupportedException();
        }

        public override void SetLength(long value)
        {
            throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            throw new NotSupportedException();
        }
    }
}
