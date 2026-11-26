// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;

/// <summary>Qualification paths are component-pinned on a physical volume; private-state ACL validation is reused unchanged.</summary>
internal sealed class SandboxPath : IDisposable
{
    private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
    internal SafeFileHandle Last
    {
        get { return handles[handles.Count - 1]; }
    }
    internal readonly string Path;

    internal SandboxPath(
        string path,
        string sid,
        bool file,
        string creatableRoot,
        string packageSid,
        string packageRoot = null
    )
    {
        Path = path;
        try
        {
            if (
                path == null
                || path.Length < 3
                || path.Length > 4096
                || path[1] != ':'
                || path[2] != '\\'
                || !String.Equals(
                    System.IO.Path.GetFullPath(path),
                    path,
                    StringComparison.OrdinalIgnoreCase
                )
            )
            {
                throw new InvalidOperationException("path");
            }
            char[] mapping = new char[4096];
            uint count = SandboxNative.QueryDosDeviceW(
                path.Substring(0, 2),
                mapping,
                (uint)mapping.Length
            );
            int end = Array.IndexOf(mapping, '\0');
            if (count == 0 || count > mapping.Length || end < 1 || end >= count)
            {
                throw new InvalidOperationException("volume");
            }
            string volume = NexaConnectorStateOwner.ValidateVolumeTarget(
                new string(mapping, 0, end)
            );
            handles.Add(Open(null, volume, true, 0x001200A1, 1, 3, null));
            Validate(Last, true, sid, false, null);
            string current = path.Substring(0, 2);
            string[] names =
                path.Length == 3 ? new string[0] : path.Substring(3).Split(new char[] { '\\' });
            for (int i = 0; i < names.Length; i++)
            {
                NexaConnectorStateOwner.ValidateLeaf(names[i]);
                current += "\\" + names[i];
                bool regular = file && i == names.Length - 1;
                bool create =
                    !regular
                    && creatableRoot != null
                    && (
                        String.Equals(current, creatableRoot, StringComparison.OrdinalIgnoreCase)
                        || current.StartsWith(
                            creatableRoot + "\\",
                            StringComparison.OrdinalIgnoreCase
                        )
                    );
                handles.Add(
                    Open(
                        Last,
                        names[i],
                        !regular,
                        regular ? 0x00120089U : 0x001200A1U,
                        create ? 3U : 1U,
                        regular ? 1U : 3U,
                        create ? Private(sid) : null
                    )
                );
                bool package =
                    packageSid != null
                    && packageRoot != null
                    && (
                        String.Equals(current, packageRoot, StringComparison.OrdinalIgnoreCase)
                        || current.StartsWith(
                            packageRoot + "\\",
                            StringComparison.OrdinalIgnoreCase
                        )
                    );
                Validate(Last, !regular, sid, create, package ? packageSid : null);
            }
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    internal static byte[] Private(string sid)
    {
        RawSecurityDescriptor value = new RawSecurityDescriptor(
            "O:" + sid + "G:SYD:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)"
        );
        byte[] bytes = new byte[value.BinaryLength];
        value.GetBinaryForm(bytes, 0);
        return bytes;
    }

    internal static SafeFileHandle Open(
        SafeFileHandle parent,
        string name,
        bool directory,
        uint access,
        uint disposition,
        uint share,
        byte[] descriptor
    )
    {
        if (parent != null)
        {
            NexaConnectorStateOwner.ValidateLeaf(name);
        }
        IntPtr text = Marshal.StringToHGlobalUni(name);
        IntPtr unicode = IntPtr.Zero;
        GCHandle pinned = new GCHandle();
        try
        {
            SandboxNative.Unicode value = new SandboxNative.Unicode
            {
                Length = checked((ushort)(name.Length * 2)),
                MaximumLength = checked((ushort)(name.Length * 2)),
                Buffer = text,
            };
            unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SandboxNative.Unicode)));
            Marshal.StructureToPtr(value, unicode, false);
            if (descriptor != null)
            {
                pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
            }
            SandboxNative.Attributes attributes = new SandboxNative.Attributes
            {
                Length = Marshal.SizeOf(typeof(SandboxNative.Attributes)),
                RootDirectory = parent == null ? IntPtr.Zero : parent.DangerousGetHandle(),
                ObjectName = unicode,
                Flags = 0x1040,
                Descriptor = descriptor == null ? IntPtr.Zero : pinned.AddrOfPinnedObject(),
            };
            SafeFileHandle result;
            SandboxNative.IoStatus status;
            int code = SandboxNative.NtCreateFile(
                out result,
                access,
                ref attributes,
                out status,
                IntPtr.Zero,
                directory ? 0x10U : 0x80U,
                share,
                disposition,
                0x200020U | (directory ? 1U : 0x40U),
                IntPtr.Zero,
                0
            );
            GC.KeepAlive(parent);
            if (code < 0)
            {
                if (result != null)
                {
                    result.Dispose();
                }
                if (code == unchecked((int)0xC0000034) || code == unchecked((int)0xC000003A))
                {
                    throw new FileNotFoundException("qualification path missing");
                }
                throw new InvalidOperationException("open");
            }
            return result;
        }
        finally
        {
            if (pinned.IsAllocated)
            {
                pinned.Free();
            }
            if (unicode != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(unicode);
            }
            Marshal.FreeHGlobal(text);
        }
    }

    internal static void Validate(
        SafeFileHandle file,
        bool directory,
        string sid,
        bool secret,
        string packageSid
    )
    {
        byte[] attributes = Information(file, SandboxFileInformation.AttributeTag, 8);
        byte[] standard = Information(file, SandboxFileInformation.Standard, 24);
        uint flags = BitConverter.ToUInt32(attributes, 0);
        if (
            (flags & 0x400) != 0
            || ((flags & 0x10) != 0) != directory
            || standard[20] != 0
            || (!directory && BitConverter.ToUInt32(standard, 16) != 1)
        )
        {
            throw new InvalidOperationException("file-kind");
        }
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr descriptor;
        if (
            SandboxNative.GetSecurityInfo(
                file,
                1,
                5,
                out owner,
                out group,
                out dacl,
                out sacl,
                out descriptor
            ) != 0
        )
        {
            throw new InvalidOperationException("acl");
        }
        try
        {
            uint size = SandboxNative.GetSecurityDescriptorLength(descriptor);
            if (size == 0 || size > 65536)
            {
                throw new InvalidOperationException("acl");
            }
            byte[] bytes = new byte[size];
            Marshal.Copy(descriptor, bytes, 0, (int)size);
            RawSecurityDescriptor parsed = new RawSecurityDescriptor(bytes, 0);
            if (packageSid != null)
            {
                if (
                    parsed.Owner == null
                    || parsed.Owner.Value != sid
                    || parsed.DiscretionaryAcl == null
                )
                {
                    throw new InvalidOperationException("profile-owner");
                }
                RawAcl filtered = new RawAcl(2, parsed.DiscretionaryAcl.Count);
                foreach (GenericAce entry in parsed.DiscretionaryAcl)
                {
                    CommonAce ace = entry as CommonAce;
                    if (ace == null || ace.IsCallback)
                    {
                        throw new InvalidOperationException("profile-acl");
                    }
                    if (ace.SecurityIdentifier.Value == packageSid)
                    {
                        continue;
                    }
                    filtered.InsertAce(filtered.Count, entry);
                }
                parsed.DiscretionaryAcl = filtered;
            }
            if (directory)
            {
                NexaConnectorStateOwner.ValidateDirectoryDescriptor(parsed, secret, sid);
            }
            else
            {
                NexaConnectorStateOwner.ValidateDescriptor(parsed, secret, sid);
            }
        }
        finally
        {
            SandboxNative.LocalFree(descriptor);
        }
    }

    internal static byte[] Information(SafeFileHandle file, SandboxFileInformation kind, int size)
    {
        byte[] bytes = new byte[size];
        if (!SandboxNative.GetFileInformationByHandleEx(file, kind, bytes, (uint)size))
        {
            throw new InvalidOperationException("information");
        }
        return bytes;
    }

    internal static byte[] Read(SafeFileHandle file, int maximum)
    {
        long size = BitConverter.ToInt64(Information(file, SandboxFileInformation.Standard, 24), 8);
        if (size < 0 || size > maximum)
        {
            throw new InvalidOperationException("size");
        }
        byte[] bytes = new byte[(int)size];
        uint read;
        if (
            size != 0
            && (
                !SandboxNative.ReadFile(file, bytes, (uint)size, out read, IntPtr.Zero)
                || read != size
            )
        )
        {
            throw new InvalidOperationException("read");
        }
        return bytes;
    }

    internal static void Write(SafeFileHandle file, byte[] bytes)
    {
        uint written;
        if (
            !SandboxNative.WriteFile(file, bytes, (uint)bytes.Length, out written, IntPtr.Zero)
            || written != bytes.Length
            || !SandboxNative.FlushFileBuffers(file)
        )
        {
            throw new InvalidOperationException("write");
        }
    }

    internal static void Delete(SafeFileHandle file)
    {
        if (!SandboxNative.SetFileInformationByHandle(file, 4, new byte[] { 1, 0, 0, 0 }, 4))
        {
            throw new InvalidOperationException("delete");
        }
    }

    public void Dispose()
    {
        for (int i = handles.Count - 1; i >= 0; i--)
        {
            handles[i].Dispose();
        }
        handles.Clear();
    }
}
