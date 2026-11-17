// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

/// <summary>Bounded state file operations retain the original lease, data protection and publication guarantees.</summary>
public static partial class NexaConnectorStateOwner
{
    private static Dictionary<string, object> LeafOperation(
        Owner owner,
        Dictionary<string, object> request,
        string operation
    )
    {
        if (operation == "list")
        {
            Fields(request, "lease");
        }
        else if (operation == "exists")
        {
            Fields(request, "lease", "name");
        }
        else if (operation == "write")
        {
            Fields(request, "lease", "name", "maximumBytes", "dataBase64", "initialize");
        }
        else
        {
            Fields(request, "lease", "name", "maximumBytes");
        }
        Lease lease = GetLease(owner, Text(request, "lease"));
        CheckAcl(lease.Path.Last, true, owner.Sid);
        if (lease.Identity != FileIdentity(lease.Path.Last))
        {
            throw new Failure("untrusted");
        }
        Dictionary<string, object> result = new Dictionary<string, object>();
        if (operation == "list")
        {
            result["names"] = List(lease.Path.Last, lease.Identity);
            return result;
        }
        string name = Text(request, "name");
        ValidateLeaf(name);
        if (name.StartsWith(".nexa-lock-", StringComparison.OrdinalIgnoreCase))
        {
            throw new Failure("invalid");
        }
        if (operation == "write")
        {
            Write(
                owner,
                lease,
                name,
                Text(request, "dataBase64"),
                Bound(request),
                Flag(request, "initialize")
            );
            return result;
        }
        if (operation == "clean-partial")
        {
            name += ".partial";
        }
        try
        {
            uint access =
                operation == "remove" || operation == "clean-partial"
                    ? ReadFileAccess | 0x10000U
                    : ReadFileAccess;
            using (SafeFileHandle file = Open(lease.Path.Last, name, access, 1, false, null, 1))
            {
                CheckObject(file, false);
                CheckAcl(file, true, owner.Sid);
                if (operation == "exists")
                {
                    result["exists"] = true;
                }
                else if (operation == "read")
                {
                    result["dataBase64"] = ReadEncoded(file, name, Bound(request), true);
                }
                else
                {
                    byte[] bytes = ReadBytes(file, Bound(request) + 4096);
                    Array.Clear(bytes, 0, bytes.Length);
                    Delete(file);
                }
            }
        }
        catch (Failure error)
        {
            if (
                error.Code != "not-found"
                || (operation != "exists" && operation != "clean-partial")
            )
            {
                throw;
            }
            if (operation == "exists")
            {
                result["exists"] = false;
            }
        }
        return result;
    }

    private static void Write(
        Owner owner,
        Lease lease,
        string name,
        string encoded,
        int maximum,
        bool initialize
    )
    {
        byte[] bytes = Decode(encoded, maximum);
        byte[] stored = bytes;
        SafeFileHandle output = null;
        bool published = false;
        try
        {
            if (IsKey(name))
            {
                byte[] cipher = ProtectedData.Protect(
                    bytes,
                    KeyEntropy,
                    DataProtectionScope.CurrentUser
                );
                stored = new byte[KeyHeader.Length + cipher.Length];
                Buffer.BlockCopy(KeyHeader, 0, stored, 0, KeyHeader.Length);
                Buffer.BlockCopy(cipher, 0, stored, KeyHeader.Length, cipher.Length);
                Array.Clear(cipher, 0, cipher.Length);
            }
            if (!initialize)
            {
                using (
                    SafeFileHandle existing = Open(
                        lease.Path.Last,
                        name,
                        ReadFileAccess,
                        1,
                        false,
                        null,
                        1
                    )
                )
                {
                    CheckObject(existing, false);
                    CheckAcl(existing, true, owner.Sid);
                    byte[] previous = ReadBytes(existing, maximum + 4096);
                    Array.Clear(previous, 0, previous.Length);
                }
            }
            output = Open(
                lease.Path.Last,
                name + ".partial",
                WriteFileAccess,
                2,
                false,
                Descriptor(owner.Sid),
                0
            );
            CheckObject(output, false);
            CheckAcl(output, true, owner.Sid);
            uint written;
            if (
                !Native.WriteFile(
                    output,
                    stored,
                    checked((uint)stored.Length),
                    out written,
                    IntPtr.Zero
                )
                || written != stored.Length
                || !Native.FlushFileBuffers(output)
            )
            {
                throw LastError();
            }
            Rename(output, lease.Path.Last, name, !initialize);
            published = true;
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
            if (!Object.ReferenceEquals(stored, bytes))
            {
                Array.Clear(stored, 0, stored.Length);
            }
            if (output != null)
            {
                try
                {
                    if (!published)
                    {
                        Delete(output);
                    }
                }
                finally
                {
                    output.Dispose();
                }
            }
        }
    }

    private static string ReadEncoded(SafeFileHandle file, string name, int maximum, bool decrypt)
    {
        byte[] bytes = ReadBytes(file, maximum + (IsKey(name) ? 4096 : 0));
        byte[] plain = bytes;
        try
        {
            if (decrypt && IsKey(name))
            {
                if (bytes.Length <= KeyHeader.Length)
                {
                    throw new Failure("untrusted");
                }
                for (int i = 0; i < KeyHeader.Length; i++)
                {
                    if (bytes[i] != KeyHeader[i])
                    {
                        throw new Failure("untrusted");
                    }
                }
                byte[] cipher = new byte[bytes.Length - KeyHeader.Length];
                Buffer.BlockCopy(bytes, KeyHeader.Length, cipher, 0, cipher.Length);
                try
                {
                    plain = ProtectedData.Unprotect(
                        cipher,
                        KeyEntropy,
                        DataProtectionScope.CurrentUser
                    );
                }
                catch
                {
                    throw new Failure("untrusted");
                }
                finally
                {
                    Array.Clear(cipher, 0, cipher.Length);
                }
            }
            if (plain.Length > maximum)
            {
                throw new Failure("limit");
            }
            return Convert.ToBase64String(plain);
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
            if (!Object.ReferenceEquals(bytes, plain))
            {
                Array.Clear(plain, 0, plain.Length);
            }
        }
    }

    private static byte[] ReadBytes(SafeFileHandle file, int maximum)
    {
        byte[] information = Information(file, 1, 24);
        long length = BitConverter.ToInt64(information, 8);
        if (length < 0 || length > maximum)
        {
            throw new Failure("limit");
        }
        byte[] bytes = new byte[checked((int)length)];
        int offset = 0;
        try
        {
            while (offset < bytes.Length)
            {
                byte[] part = new byte[Math.Min(65536, bytes.Length - offset)];
                uint read;
                try
                {
                    if (
                        !Native.ReadFile(file, part, (uint)part.Length, out read, IntPtr.Zero)
                        || read == 0
                    )
                    {
                        throw LastError();
                    }
                    Buffer.BlockCopy(part, 0, bytes, offset, checked((int)read));
                    offset += checked((int)read);
                }
                finally
                {
                    Array.Clear(part, 0, part.Length);
                }
            }
            if (BitConverter.ToInt64(Information(file, 1, 24), 8) != length)
            {
                throw new Failure("untrusted");
            }
            return bytes;
        }
        catch
        {
            Array.Clear(bytes, 0, bytes.Length);
            throw;
        }
    }
}
