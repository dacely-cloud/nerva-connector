// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

public static partial class NexaConnectorStateOwner
{
    /// <summary>Exercises the production path checks on isolated NTFS folders owned by the caller.</summary>
    public static void QualifySharedLocalAppData()
    {
        string profile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "nerva-storage-qualification-" + Guid.NewGuid().ToString("N")
        );
        string local = Path.Combine(profile, "AppData", "Local");
        string sid = WindowsIdentity.GetCurrent().User.Value;
        DirectorySecurity privateAcl = new DirectorySecurity();
        privateAcl.SetSecurityDescriptorBinaryForm(Descriptor(sid));
        Directory.CreateDirectory(profile, privateAcl);
        try
        {
            Directory.CreateDirectory(local);
            Directory.SetAccessControl(local, privateAcl);
            using (Owner owner = new Owner(sid, local, profile))
            {
                RequireStorageQualification(DefaultStateRoot(owner) == owner.Root);
                DirectorySecurity shared = new DirectorySecurity();
                shared.SetSecurityDescriptorBinaryForm(Descriptor(sid));
                shared.AddAccessRule(
                    new FileSystemAccessRule(
                        new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
                        FileSystemRights.Modify,
                        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                        PropagationFlags.None,
                        AccessControlType.Allow
                    )
                );
                Directory.SetAccessControl(local, shared);
                string localAcl = Directory
                    .GetAccessControl(local)
                    .GetSecurityDescriptorSddlForm(AccessControlSections.Access);
                RequireStorageQualification(DefaultStateRoot(owner) == owner.ProfileRoot);
                RequireStorageQualification(!Directory.Exists(owner.ProfileRoot));
                using (OpenPath(owner, owner.ProfileRoot, true, true)) { }
                RequireStorageQualification(DefaultStateRoot(owner) == owner.ProfileRoot);
                RequireStorageQualification(
                    Directory
                        .GetAccessControl(local)
                        .GetSecurityDescriptorSddlForm(AccessControlSections.Access) == localAcl
                );
                RequireStorageQualification(!Directory.Exists(owner.Root));

                Directory.CreateDirectory(Path.Combine(local, "Nerva"));
                RequireStorageRejection(owner, "untrusted", "local-app-data");
                Directory.Delete(Path.Combine(local, "Nerva"));

                privateAcl.SetSecurityDescriptorBinaryForm(Descriptor(sid));
                Directory.SetAccessControl(local, privateAcl);
                RequireStorageQualification(DefaultStateRoot(owner) == owner.ProfileRoot);
                using (OpenPath(owner, owner.Root, true, true)) { }
                RequireStorageRejection(owner, "migration-required", null);
                RequireStorageQualification(Directory.Exists(owner.Root));
                RequireStorageQualification(Directory.Exists(owner.ProfileRoot));
            }
        }
        catch (Failure error)
        {
            throw new InvalidOperationException(
                "Windows storage qualification failed: " + error.Scope + "/" + error.Check,
                error
            );
        }
        finally
        {
            Directory.Delete(profile, true);
        }
    }

    private static void RequireStorageRejection(Owner owner, string code, string scope)
    {
        try
        {
            DefaultStateRoot(owner);
        }
        catch (Failure error)
        {
            RequireStorageQualification(error.Code == code && error.Scope == scope);
            return;
        }
        throw new InvalidOperationException(
            "Existing state did not prevent alternate root selection"
        );
    }

    private static void RequireStorageQualification(bool condition)
    {
        if (!condition)
        {
            throw new InvalidOperationException(
                "Windows protected storage root qualification failed"
            );
        }
    }
}

/// <summary>Entry point only compiled into the Windows qualification executable.</summary>
public static class WindowsStateProfileFixture
{
    public static void Main()
    {
        NexaConnectorStateOwner.QualifySharedLocalAppData();
        Console.WriteLine("windows-state-profile-qualified");
    }
}
