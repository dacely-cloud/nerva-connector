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
        QualifySharedLocalAppData(false);
        QualifySharedLocalAppData(true);
    }

    private static void QualifySharedLocalAppData(bool shareParent)
    {
        string profile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "nerva-storage-qualification-" + Guid.NewGuid().ToString("N")
        );
        string appData = Path.Combine(profile, "AppData");
        string local = Path.Combine(appData, "Local");
        string sid = WindowsIdentity.GetCurrent().User.Value;
        Directory.CreateDirectory(profile, FixtureAcl(sid, false));
        try
        {
            Directory.CreateDirectory(local);
            Directory.SetAccessControl(local, FixtureAcl(sid, false));
            using (Owner owner = new Owner(sid, local, profile))
            {
                RequireStorageQualification(DefaultStateRoot(owner) == owner.Root);
                using (OpenPath(owner, owner.Root, true, true)) { }
                string oldPairing = Path.Combine(owner.Root, "pairing.json");
                File.WriteAllText(oldPairing, "existing legacy state");
                RequireStorageQualification(DefaultStateRoot(owner) == owner.Root);
                if (shareParent)
                {
                    Directory.SetAccessControl(appData, FixtureAcl(sid, true));
                }
                Directory.SetAccessControl(local, FixtureAcl(sid, true));
                string localAcl = Directory
                    .GetAccessControl(local)
                    .GetSecurityDescriptorSddlForm(AccessControlSections.Access);
                string parentAcl = Directory
                    .GetAccessControl(appData)
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
                RequireStorageQualification(File.ReadAllText(oldPairing) == "existing legacy state");
                RequireStorageQualification(
                    Directory
                        .GetAccessControl(appData)
                        .GetSecurityDescriptorSddlForm(AccessControlSections.Access) == parentAcl
                );

                if (shareParent)
                {
                    Directory.SetAccessControl(appData, FixtureAcl(sid, false));
                }
                Directory.SetAccessControl(local, FixtureAcl(sid, false));
                RequireStorageQualification(DefaultStateRoot(owner) == owner.ProfileRoot);
                RequireStorageQualification(Directory.Exists(owner.Root));
                RequireStorageQualification(Directory.Exists(owner.ProfileRoot));

                Directory.SetAccessControl(owner.ProfileRoot, FixtureAcl(sid, true));
                RequireStorageRejection(owner, "untrusted", "connector-state");
                Directory.SetAccessControl(owner.ProfileRoot, FixtureAcl(sid, false));
                Directory.Delete(owner.ProfileRoot);
                Directory.SetAccessControl(Path.Combine(local, "Nerva"), FixtureAcl(sid, true));
                RequireStorageQualification(DefaultStateRoot(owner) == owner.ProfileRoot);
                RequireStorageQualification(!Directory.Exists(owner.ProfileRoot));
                RequireStorageQualification(File.ReadAllText(oldPairing) == "existing legacy state");
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

    private static DirectorySecurity FixtureAcl(string sid, bool shared)
    {
        DirectorySecurity acl = new DirectorySecurity();
        acl.SetSecurityDescriptorBinaryForm(Descriptor(sid));
        if (shared)
        {
            foreach (
                SecurityIdentifier principal in new SecurityIdentifier[]
                {
                    new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
                    new SecurityIdentifier("S-1-5-21-101-202-303-1002"),
                }
            )
            {
                acl.AddAccessRule(
                    new FileSystemAccessRule(
                        principal,
                        FileSystemRights.Modify,
                        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                        PropagationFlags.None,
                        AccessControlType.Allow
                    )
                );
            }
        }
        return acl;
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
