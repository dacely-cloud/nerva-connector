// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

/// <summary>Canonical paths and volume anchors are resolved through pinned directory handles.</summary>
public static partial class NexaConnectorStateOwner
{
    private static PinnedPath OpenPath(
        Owner owner,
        string path,
        bool privateTarget,
        bool create,
        bool inspectLocalAppData = false
    )
    {
        path = Canonical(path);
        if (
            inspectLocalAppData
            && (
                privateTarget
                || create
                || !String.Equals(path, owner.Base, StringComparison.OrdinalIgnoreCase)
            )
        )
        {
            throw new Failure("invalid");
        }
        PinnedPath held = new PinnedPath();
        string scope = "volume";
        try
        {
            string root = path.Substring(0, 3);
            SafeFileHandle volume = Open(
                null,
                owner.NativeRoot(path),
                ReadDirectory,
                1,
                true,
                null,
                3
            );
            held.Handles.Add(volume);
            CheckObject(volume, true);
            CheckAcl(volume, false, owner.Sid, true);
            string current = root.TrimEnd(new char[] { '\\' });
            string[] parts =
                path.Length == 3 ? new string[0] : path.Substring(3).Split(new char[] { '\\' });
            for (int i = 0; i < parts.Length; i++)
            {
                current += "\\" + parts[i];
                bool managed = owner.Managed(current);
                bool localAppData = String.Equals(
                    current,
                    owner.Base,
                    StringComparison.OrdinalIgnoreCase
                );
                bool nervaFolder = String.Equals(
                    current,
                    owner.Base + "\\Nerva",
                    StringComparison.OrdinalIgnoreCase
                );
                bool creatable = managed || nervaFolder;
                scope =
                    managed ? "connector-state"
                    : nervaFolder ? "nerva-folder"
                    : localAppData ? "local-app-data"
                    : Inside(owner.Base, current) ? "profile-ancestor"
                    : "other-directory";
                SafeFileHandle next = Open(
                    held.Last,
                    parts[i],
                    ReadDirectory,
                    create && creatable ? 3U : 1U,
                    true,
                    create && creatable ? Descriptor(owner.Sid) : null,
                    3
                );
                held.Handles.Add(next);
                CheckObject(next, true);
                if (!localAppData || !inspectLocalAppData)
                {
                    CheckAcl(
                        next,
                        managed || (privateTarget && i == parts.Length - 1),
                        owner.Sid,
                        !localAppData
                    );
                }
            }
            return held;
        }
        catch (Failure error)
        {
            if (error.Check != null)
            {
                error.Scope = scope;
            }
            held.Dispose();
            throw;
        }
        catch
        {
            held.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Use the protected profile directory for a first run when LocalAppData is shared.
    /// Never read state through the shared directory or abandon an existing installation.
    /// </summary>
    private static string DefaultStateRoot(Owner owner)
    {
        bool profileStateExists = StateDirectoryExists(owner, owner.ProfileRoot);
        using (PinnedPath local = OpenPath(owner, owner.Base, false, false, true))
        {
            try
            {
                CheckAcl(local.Last, false, owner.Sid);
            }
            catch (Failure error)
            {
                error.Scope = "local-app-data";
                if (
                    error.Code != "untrusted"
                    || error.Check != "unexpected-permission"
                    || !SharedLocalAppDataIsEmptyOfNerva(local.Last)
                )
                {
                    throw;
                }
                return owner.ProfileRoot;
            }
        }
        if (!profileStateExists)
        {
            return owner.Root;
        }
        if (StateDirectoryExists(owner, owner.Root))
        {
            throw new Failure("migration-required");
        }
        return owner.ProfileRoot;
    }

    private static bool StateDirectoryExists(Owner owner, string path)
    {
        try
        {
            using (OpenPath(owner, path, true, false)) { }
            return true;
        }
        catch (Failure error)
        {
            if (error.Code != "not-found")
            {
                throw;
            }
            return false;
        }
    }

    private static bool SharedLocalAppDataIsEmptyOfNerva(SafeFileHandle parent)
    {
        // This handle is only used to probe the original root's first component. Since this base
        // failed verification, its contents must not supply state, even if the child ACL looks safe.
        try
        {
            using (Open(parent, "Nerva", 0x00100080U, 1, true, null, 3)) { }
            return false;
        }
        catch (Failure error)
        {
            return error.Code == "not-found";
        }
    }

    private static SafeFileHandle Open(
        SafeFileHandle parent,
        string name,
        uint access,
        uint disposition,
        bool directory,
        byte[] descriptor,
        uint share,
        uint extraOptions = 0
    )
    {
        if (parent != null)
        {
            ValidateLeaf(name);
        }
        IntPtr nameBuffer = Marshal.StringToHGlobalUni(name);
        IntPtr unicodeBuffer = IntPtr.Zero;
        GCHandle security = new GCHandle();
        try
        {
            Native.UNICODE_STRING unicode = new Native.UNICODE_STRING
            {
                Length = checked((ushort)(name.Length * 2)),
                MaximumLength = checked((ushort)(name.Length * 2)),
                Buffer = nameBuffer,
            };
            unicodeBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.UNICODE_STRING)));
            Marshal.StructureToPtr(unicode, unicodeBuffer, false);
            if (descriptor != null)
            {
                security = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
            }
            Native.OBJECT_ATTRIBUTES attributes = new Native.OBJECT_ATTRIBUTES
            {
                Length = Marshal.SizeOf(typeof(Native.OBJECT_ATTRIBUTES)),
                RootDirectory = parent == null ? IntPtr.Zero : parent.DangerousGetHandle(),
                ObjectName = unicodeBuffer,
                Attributes = 0x1040,
                SecurityDescriptor =
                    descriptor == null ? IntPtr.Zero : security.AddrOfPinnedObject(),
            };
            Native.IO_STATUS_BLOCK result;
            SafeFileHandle handle;
            int status = Native.NtCreateFile(
                out handle,
                access,
                ref attributes,
                out result,
                IntPtr.Zero,
                directory ? 0x10U : 0x80U,
                share,
                disposition,
                0x200020U | (directory ? 1U : 0x40U) | extraOptions,
                IntPtr.Zero,
                0
            );
            GC.KeepAlive(parent);
            if (status < 0)
            {
                if (handle != null)
                {
                    handle.Dispose();
                }
                throw Status(status);
            }
            return handle;
        }
        finally
        {
            if (security.IsAllocated)
            {
                security.Free();
            }
            if (unicodeBuffer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(unicodeBuffer);
            }
            Marshal.FreeHGlobal(nameBuffer);
        }
    }

    /// <summary>Names never select an alternate stream, device, traversal, ambiguous suffix or reparse path.</summary>
    public static void ValidateLeaf(string name)
    {
        if (
            String.IsNullOrEmpty(name)
            || name.Length > 255
            || name == "."
            || name == ".."
            || name.EndsWith(".", StringComparison.Ordinal)
            || name.EndsWith(" ", StringComparison.Ordinal)
        )
        {
            throw new Failure("invalid");
        }
        foreach (char value in name)
        {
            if (value < 32 || value == 127 || "\\/:*?\"<>|".IndexOf(value) >= 0)
            {
                throw new Failure("invalid");
            }
        }
        if (
            !ValidUnicode(name)
            || Regex.IsMatch(
                name,
                "^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\\$|CONOUT\\$|CLOCK\\$)([ .]|$)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
            )
        )
        {
            throw new Failure("invalid");
        }
    }

    private static string Canonical(string path)
    {
        if (
            path == null
            || path.Length < 3
            || path.Length > 4096
            || (Char.ToUpperInvariant(path[0]) < 'A' || Char.ToUpperInvariant(path[0]) > 'Z')
            || path[1] != ':'
            || path[2] != '\\'
            || path.IndexOf('/') >= 0
            || !String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase)
        )
        {
            throw new Failure("invalid");
        }
        if (path.Length > 3)
        {
            foreach (string name in path.Substring(3).Split(new char[] { '\\' }))
            {
                ValidateLeaf(name);
            }
        }
        return path;
    }

    private static bool Inside(string path, string root)
    {
        return String.Equals(path, root, StringComparison.OrdinalIgnoreCase)
            || path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Only a direct kernel disk-volume device can anchor state; SUBST, UNC and namespace aliases are refused.</summary>
    public static string ValidateVolumeTarget(string mapping)
    {
        if (
            mapping == null
            || mapping.Length > 128
            || !Regex.IsMatch(
                mapping,
                @"\A\\Device\\HarddiskVolume[0-9]+\z",
                RegexOptions.CultureInvariant
            )
        )
        {
            throw new Failure("untrusted", "unsupported-volume") { Scope = "volume" };
        }
        return mapping + "\\";
    }

    private static string QueryVolume(string drive)
    {
        char[] buffer = new char[4096];
        uint count = Native.QueryDosDeviceW(drive, buffer, (uint)buffer.Length);
        if (count == 0)
        {
            throw LastError();
        }
        if (count > buffer.Length || buffer[count - 1] != '\0')
        {
            throw new Failure("untrusted", "unsupported-volume") { Scope = "volume" };
        }
        int end = Array.IndexOf(buffer, '\0');
        if (end <= 0 || end >= count)
        {
            throw new Failure("untrusted", "unsupported-volume") { Scope = "volume" };
        }
        return ValidateVolumeTarget(new string(buffer, 0, end));
    }
}
