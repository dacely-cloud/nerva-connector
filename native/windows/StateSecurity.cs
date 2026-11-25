// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

/// <summary>Every opened state object is checked against the owner SID and the required DACL.</summary>
public static partial class NexaConnectorStateOwner
{
    /// <summary>
    /// List, read-EA, traverse, read-attributes, read-control, synchronize, generic read and generic execute on a directory.
    /// </summary>
    /// <remarks>
    /// None of these rights opens, adds, renames, removes or re-permits a child, or changes the directory itself.
    /// </remarks>
    private const int DirectoryReadRights = unchecked((int)0xA01200A9);

    private static byte[] Descriptor(string sid)
    {
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(
            "O:" + sid + "G:SYD:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)"
        );
        byte[] bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        return bytes;
    }

    /// <summary>Pure validation of a file permits only the current owner and SYSTEM on private state; never repairs an existing ACL.</summary>
    public static void ValidateDescriptor(
        RawSecurityDescriptor descriptor,
        bool secret,
        string expectedSid
    )
    {
        ValidateDescriptorCore(descriptor, secret, expectedSid, false, false);
    }

    /// <summary>Pinned ancestors may grant child creation, but never foreign replacement or ACL authority.</summary>
    /// <remarks>
    /// A private directory may also carry explicit grants limited to <see cref="DirectoryReadRights"/>. Codex's
    /// Windows sandbox repeatedly added an entry for its CodexSandboxUsers group to the user's
    /// %USERPROFILE%\.nerva-connector-state folder, which made the connector refuse its own storage. Such a grant
    /// reveals file names and attributes only: every file is still created with a protected owner-and-SYSTEM
    /// descriptor and is checked on each open, so an inheritable grant can never reach one unnoticed.
    /// </remarks>
    public static void ValidateDirectoryDescriptor(
        RawSecurityDescriptor descriptor,
        bool secret,
        string expectedSid
    )
    {
        ValidateDescriptorCore(descriptor, secret, expectedSid, true, true);
    }

    private static void ValidateDescriptorCore(
        RawSecurityDescriptor descriptor,
        bool secret,
        string expectedSid,
        bool ancestor,
        bool directory
    )
    {
        if (descriptor == null || descriptor.Owner == null || descriptor.DiscretionaryAcl == null)
        {
            throw new Failure("untrusted", "invalid-descriptor");
        }
        string owner = descriptor.Owner.Value;
        if (secret ? owner != expectedSid : !Trusted(owner, expectedSid))
        {
            throw new Failure("untrusted", "unexpected-owner");
        }
        if (secret && (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0)
        {
            throw new Failure("untrusted", "inherited-permissions");
        }
        bool user = false;
        bool system = false;
        foreach (GenericAce entry in descriptor.DiscretionaryAcl)
        {
            CommonAce ace = entry as CommonAce;
            if ((entry.AceFlags & AceFlags.InheritOnly) != 0)
            {
                if (secret && !(directory && ReadGrant(ace)))
                {
                    throw new Failure("untrusted", "inherited-permissions");
                }
                continue;
            }
            if (ace == null || ace.IsCallback)
            {
                throw new Failure("untrusted", "unexpected-permission");
            }
            string sid = ace.SecurityIdentifier.Value;
            if (ace.AceQualifier != AceQualifier.AccessAllowed)
            {
                if (secret)
                {
                    throw new Failure("untrusted", "unexpected-permission");
                }
                continue;
            }
            if (secret)
            {
                if (
                    (ace.AceFlags & AceFlags.Inherited) != 0
                    || (sid != expectedSid && sid != "S-1-5-18")
                )
                {
                    if (directory && ReadGrant(ace))
                    {
                        continue;
                    }
                    throw new Failure("untrusted", "unexpected-permission");
                }
                if (sid == expectedSid)
                {
                    user = true;
                }
                if (sid == "S-1-5-18")
                {
                    system = true;
                }
            }
            else if (
                !Trusted(sid, expectedSid)
                && !Sandboxed(sid)
                && (ace.AccessMask & unchecked((int)(ancestor ? 0x500D0150 : 0x500D0156))) != 0
            )
            {
                throw new Failure("untrusted", "unexpected-permission");
            }
        }
        if (secret && (!user || !system))
        {
            throw new Failure("untrusted", "missing-permission");
        }
    }

    /// <summary>An explicit allow entry whose rights stay within <see cref="DirectoryReadRights"/>.</summary>
    private static bool ReadGrant(CommonAce ace)
    {
        return ace != null
            && !ace.IsCallback
            && ace.AceQualifier == AceQualifier.AccessAllowed
            && (ace.AceFlags & AceFlags.Inherited) == 0
            && (ace.AccessMask & ~DirectoryReadRights) == 0;
    }

    /// <summary>
    /// AppContainer (S-1-15-2-*) and capability (S-1-15-3-*) SIDs on a folder that holds no secret never name another account.
    /// </summary>
    /// <remarks>
    /// Windows evaluates them only for this user's own sandboxed apps, and grants such an app access only when the user's
    /// own entry allows it too, so they give no process more than this user's ordinary programs already have. Some PCs
    /// grant ALL APPLICATION PACKAGES or one app's package change rights on AppData\Local or AppData\Local\Nerva, which made
    /// the connector refuse to start there. The private Nerva\Connector folder and its files still allow only this user and
    /// SYSTEM.
    /// </remarks>
    private static bool Sandboxed(string sid)
    {
        return sid.StartsWith("S-1-15-2-", StringComparison.Ordinal)
            || sid.StartsWith("S-1-15-3-", StringComparison.Ordinal);
    }

    private static bool Trusted(string sid, string user)
    {
        return sid == user
            || sid == "S-1-5-18"
            || sid == "S-1-5-32-544"
            || sid == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    }

    private static void CheckAcl(
        SafeFileHandle handle,
        bool secret,
        string sid,
        bool ancestor = false
    )
    {
        bool directory = (BitConverter.ToUInt32(Information(handle, 9, 8), 0) & 0x10) != 0;
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr descriptor;
        uint status = Native.GetSecurityInfo(
            handle,
            1,
            5,
            out owner,
            out group,
            out dacl,
            out sacl,
            out descriptor
        );
        if (status != 0)
        {
            throw new Failure("untrusted", "descriptor-unreadable");
        }
        try
        {
            uint length = Native.GetSecurityDescriptorLength(descriptor);
            if (length == 0 || length > 65536)
            {
                throw new Failure("untrusted", "invalid-descriptor");
            }
            byte[] bytes = new byte[length];
            Marshal.Copy(descriptor, bytes, 0, checked((int)length));
            ValidateDescriptorCore(
                new RawSecurityDescriptor(bytes, 0),
                secret,
                sid,
                ancestor,
                directory
            );
        }
        finally
        {
            Native.LocalFree(descriptor);
        }
    }

    private static void CheckObject(SafeFileHandle handle, bool directory)
    {
        byte[] attributes = Information(handle, 9, 8);
        uint flags = BitConverter.ToUInt32(attributes, 0);
        byte[] standard = Information(handle, 1, 24);
        if ((flags & 0x400) != 0)
        {
            throw new Failure("untrusted", "reparse-point");
        }
        if (
            ((flags & 0x10) != 0) != directory
            || standard[20] != 0
            || (!directory && BitConverter.ToUInt32(standard, 16) != 1)
        )
        {
            throw new Failure("untrusted", "unexpected-file-type");
        }
    }
}
