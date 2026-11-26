// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
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
        QualifyLegacyStorage();
    }

    /// <summary>Shared unrelated folders cannot block absent legacy state or hide retained identities.</summary>
    private static void QualifyLegacyStorage()
    {
        string profile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "nerva-storage-qualification-" + Guid.NewGuid().ToString("N")
        );
        string sid = WindowsIdentity.GetCurrent().User.Value;
        Directory.CreateDirectory(profile, FixtureAcl(sid, false));
        try
        {
            string localAppData = Path.Combine(profile, "AppData", "Local");
            Directory.CreateDirectory(localAppData);
            Directory.SetAccessControl(localAppData, FixtureAcl(sid, true));
            using (Owner owner = new Owner(sid, localAppData, profile))
            {
                string legacy = profile;
                RequireStorageQualification(DefaultStateRoot(owner) == owner.ProfileRoot);
                foreach (string name in new string[] { ".local", "share", "nerva-connector" })
                {
                    legacy = Path.Combine(legacy, name);
                    Directory.CreateDirectory(legacy, FixtureAcl(sid, true));
                    string acl = Directory
                        .GetAccessControl(legacy)
                        .GetSecurityDescriptorSddlForm(
                            AccessControlSections.Owner
                                | AccessControlSections.Group
                                | AccessControlSections.Access
                        );
                    RequireStorageQualification(DefaultStateRoot(owner) == owner.ProfileRoot);
                    RequireStorageQualification(
                        Directory
                            .GetAccessControl(legacy)
                            .GetSecurityDescriptorSddlForm(
                                AccessControlSections.Owner
                                    | AccessControlSections.Group
                                    | AccessControlSections.Access
                            ) == acl
                    );
                }
                string state = Path.Combine(legacy, "state");
                Directory.CreateDirectory(state, FixtureAcl(sid, true));
                foreach (
                    string relative in new string[]
                    {
                        "device-key.json",
                        "pairing-state",
                        "device.json",
                        "state\\device-key.json",
                        "state\\device-key.pem",
                        "state\\pairing-state",
                        "state\\device.json",
                    }
                )
                {
                    string marker = Path.Combine(legacy, relative);
                    File.WriteAllText(marker, "preserve existing identity");
                    RequireLegacyRejection(owner, "migration-required");
                    RequireStorageQualification(
                        File.ReadAllText(marker) == "preserve existing identity"
                    );
                    File.Delete(marker);
                }
                RequireStorageQualification(DefaultStateRoot(owner) == owner.ProfileRoot);
                DirectorySecurity denied = FixtureAcl(sid, true);
                denied.AddAccessRule(
                    new FileSystemAccessRule(
                        new SecurityIdentifier(sid),
                        FileSystemRights.ReadData,
                        AccessControlType.Deny
                    )
                );
                Directory.SetAccessControl(state, denied);
                try
                {
                    RequireLegacyRejection(owner, "untrusted");
                }
                finally
                {
                    Directory.SetAccessControl(state, FixtureAcl(sid, true));
                }
                using (OpenPath(owner, owner.ProfileRoot, true, true)) { }
                File.WriteAllText(Path.Combine(state, "device.json"), "retained identity");
                RequireLegacyRejection(owner, "migration-required");
                File.Delete(Path.Combine(state, "device.json"));
                RequireStorageQualification(DefaultStateRoot(owner) == owner.ProfileRoot);
                Directory.SetAccessControl(owner.ProfileRoot, FixtureAcl(sid, true));
                RequireStorageRejection(owner, "untrusted", "connector-state");
            }
        }
        finally
        {
            Directory.Delete(profile, true);
        }
    }

    private static void RequireLegacyRejection(Owner owner, string code)
    {
        try
        {
            DefaultStateRoot(owner);
        }
        catch (Failure error)
        {
            RequireStorageQualification(error.Code == code);
            return;
        }
        throw new InvalidOperationException("Legacy state was incorrectly treated as absent");
    }

    /// <summary>The caller supplies an isolated profile whose .local entry is a junction.</summary>
    public static void QualifyLegacyJunction(string profile)
    {
        using (
            Owner owner = new Owner(
                WindowsIdentity.GetCurrent().User.Value,
                Path.Combine(profile, "AppData", "Local"),
                profile
            )
        )
        {
            RequireLegacyRejection(owner, "untrusted");
        }
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
                RequireStorageQualification(
                    File.ReadAllText(oldPairing) == "existing legacy state"
                );
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
                RequireStorageQualification(
                    File.ReadAllText(oldPairing) == "existing legacy state"
                );
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
        acl.SetSecurityDescriptorBinaryForm(
            Descriptor(sid),
            AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access
        );
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
    public static void Main(string[] arguments)
    {
        if (arguments.Length == 1)
        {
            NexaConnectorStateOwner.QualifyLegacyJunction(arguments[0]);
            Console.WriteLine("windows-state-junction-rejected");
            return;
        }
        NexaConnectorStateOwner.QualifySharedLocalAppData();
        Console.WriteLine("windows-state-profile-qualified");
    }
}
