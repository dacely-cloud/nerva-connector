// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

/// <summary>Descriptor-relative directory enumeration and mutation never replace the pinned authority.</summary>
public static partial class NexaConnectorStateOwner
{
    private static byte[] Information(SafeFileHandle file, int kind, int size)
    {
        byte[] bytes = new byte[size];
        if (!Native.GetFileInformationByHandleEx(file, kind, bytes, (uint)size))
        {
            throw LastError();
        }
        return bytes;
    }

    private static string FileIdentity(SafeFileHandle directory)
    {
        return Convert.ToBase64String(Information(directory, 18, 24));
    }

    private static string LockName(string purpose, string identity)
    {
        using (SHA256 digest = SHA256.Create())
        {
            return ".nexa-lock-"
                + purpose
                + "-"
                + BitConverter
                    .ToString(digest.ComputeHash(Encoding.UTF8.GetBytes(purpose + ":" + identity)))
                    .Replace("-", "")
                    .ToLowerInvariant();
        }
    }

    private static void Rename(
        SafeFileHandle file,
        SafeFileHandle directory,
        string name,
        bool replace
    )
    {
        byte[] encoded = Encoding.Unicode.GetBytes(name);
        int rootOffset = IntPtr.Size == 8 ? 8 : 4;
        int lengthOffset = rootOffset + IntPtr.Size;
        int nameOffset = lengthOffset + 4;
        int size = Math.Max(IntPtr.Size == 8 ? 24 : 16, nameOffset + encoded.Length + 2);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int i = 0; i < size; i++)
            {
                Marshal.WriteByte(buffer, i, 0);
            }
            Marshal.WriteByte(buffer, 0, replace ? (byte)1 : (byte)0);
            Marshal.WriteIntPtr(buffer, rootOffset, directory.DangerousGetHandle());
            Marshal.WriteInt32(buffer, lengthOffset, encoded.Length);
            Marshal.Copy(encoded, 0, IntPtr.Add(buffer, nameOffset), encoded.Length);
            Native.IO_STATUS_BLOCK result;
            int status = Native.NtSetInformationFile(file, out result, buffer, (uint)size, 10);
            GC.KeepAlive(directory);
            if (status < 0)
            {
                throw Status(status);
            }
            if (!Native.FlushFileBuffers(file))
            {
                throw LastError();
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void Delete(SafeFileHandle file)
    {
        IntPtr buffer = Marshal.AllocHGlobal(1);
        try
        {
            Marshal.WriteByte(buffer, 1);
            Native.IO_STATUS_BLOCK result;
            int status = Native.NtSetInformationFile(file, out result, buffer, 1, 13);
            if (status < 0)
            {
                throw Status(status);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string[] List(SafeFileHandle directory, string identity)
    {
        List<string> names = new List<string>();
        byte[] buffer = new byte[8192];
        bool restart = true;
        while (true)
        {
            Native.IO_STATUS_BLOCK result;
            int status = Native.NtQueryDirectoryFile(
                directory,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                out result,
                buffer,
                (uint)buffer.Length,
                12,
                false,
                IntPtr.Zero,
                restart
            );
            restart = false;
            if (status == unchecked((int)0x80000006))
            {
                break;
            }
            if (status < 0)
            {
                throw Status(status);
            }
            int available = checked((int)result.Information.ToUInt64());
            if (available < 12 || available > buffer.Length)
            {
                throw new Failure("io");
            }
            int offset = 0;
            while (true)
            {
                if (offset < 0 || offset + 12 > available)
                {
                    throw new Failure("io");
                }
                int next = BitConverter.ToInt32(buffer, offset);
                int length = BitConverter.ToInt32(buffer, offset + 8);
                if (length < 0 || (length & 1) != 0 || offset + 12 + length > available)
                {
                    throw new Failure("io");
                }
                string name = Encoding.Unicode.GetString(buffer, offset + 12, length);
                bool ownLock = false;
                foreach (string purpose in Purposes)
                {
                    if (name == LockName(purpose, identity))
                    {
                        ownLock = true;
                    }
                }
                if (name != "." && name != ".." && !ownLock)
                {
                    ValidateLeaf(name);
                    names.Add(name);
                    if (names.Count > 128)
                    {
                        throw new Failure("limit");
                    }
                }
                if (next == 0)
                {
                    break;
                }
                if (next < 12 || offset + next <= offset)
                {
                    throw new Failure("io");
                }
                offset += next;
            }
        }
        names.Sort(StringComparer.Ordinal);
        return names.ToArray();
    }
}
