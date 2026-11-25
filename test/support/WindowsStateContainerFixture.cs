// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

public static partial class NexaConnectorStateOwner
{
    private const string ContainerReader = "S-1-5-21-101-202-303-1002";
    private const int FixtureReadAccess = 0x001200A9;

    /// <summary>Exercises concrete read rights, every forbidden bit and unchanged private-object policy.</summary>
    private static void QualifyContainerPolicy(string sid)
    {
        string clean = "O:" + sid + "G:SYD:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)";
        string readable = clean + "(A;OICI;0x1200a9;;;" + ContainerReader + ")";
        ValidateDescriptorCore(new RawSecurityDescriptor(readable), true, sid, false, true);
        RejectContainerPolicy(
            delegate
            {
                ValidateDescriptor(new RawSecurityDescriptor(readable), true, sid);
            }
        );
        RejectContainerPolicy(
            delegate
            {
                ValidateDirectoryDescriptor(new RawSecurityDescriptor(readable), true, sid);
            }
        );
        for (int shift = 0; shift < 32; shift++)
        {
            uint bit = 1U << shift;
            string acl = clean + "(A;OICI;0x" + bit.ToString("x") + ";;;" + ContainerReader + ")";
            if ((bit & FixtureReadAccess) != 0)
                ValidateDescriptorCore(new RawSecurityDescriptor(acl), true, sid, false, true);
            else
                RejectContainerPolicy(
                    delegate
                    {
                        ValidateDescriptorCore(
                            new RawSecurityDescriptor(acl),
                            true,
                            sid,
                            false,
                            true
                        );
                    }
                );
        }
        foreach (
            string unsafeAcl in new string[]
            {
                readable.Replace("O:" + sid, "O:" + ContainerReader),
                readable.Replace("D:P", "D:"),
                readable.Replace("(A;OICI;FA;;;SY)", ""),
                readable.Replace("(A;OICI;FA;;;" + sid + ")", ""),
                readable.Replace("(A;OICI;0x1200a9", "(A;OICIID;0x1200a9"),
                readable.Replace("(A;OICI;0x1200a9", "(A;OICIIO;0x1200a9"),
                readable.Replace("(A;OICI;0x1200a9", "(D;OICI;0x1200a9"),
            }
        )
        {
            RejectContainerPolicy(
                delegate
                {
                    ValidateDescriptorCore(
                        new RawSecurityDescriptor(unsafeAcl),
                        true,
                        sid,
                        false,
                        true
                    );
                }
            );
        }
    }

    private static void RejectContainerPolicy(Action operation)
    {
        try
        {
            operation();
        }
        catch (Failure error)
        {
            if (error.Code == "untrusted")
                return;
            throw;
        }
        throw new InvalidOperationException("Unsafe container policy was accepted");
    }

    private static DirectorySecurity ContainerFixtureAcl(string sid, bool readable)
    {
        DirectorySecurity acl = new DirectorySecurity();
        acl.SetSecurityDescriptorBinaryForm(
            Descriptor(sid),
            AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access
        );
        if (readable)
            acl.AddAccessRule(
                new FileSystemAccessRule(
                    new SecurityIdentifier(ContainerReader),
                    (FileSystemRights)FixtureReadAccess,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None,
                    AccessControlType.Allow
                )
            );
        return acl;
    }

    private static Dictionary<string, object> ContainerRequest(string operation)
    {
        Dictionary<string, object> request = new Dictionary<string, object>();
        foreach (string field in RequestFields)
            request[field] = null;
        request["operation"] = operation;
        return request;
    }

    private static string OpenContainerFixture(Owner owner, string path)
    {
        Dictionary<string, object> request = ContainerRequest("open");
        request["path"] = path;
        request["purpose"] = "installation";
        return (string)Dispatch(owner, request)["lease"];
    }

    private static Dictionary<string, object> ContainerLeaf(
        Owner owner,
        string lease,
        string operation
    )
    {
        Dictionary<string, object> request = ContainerRequest(operation);
        request["lease"] = lease;
        if (operation == "read" || operation == "write")
        {
            request["name"] = "fixture.json";
            request["maximumBytes"] = 128;
        }
        if (operation == "write")
        {
            request["dataBase64"] = "dGVzdA==";
            request["initialize"] = true;
        }
        return Dispatch(owner, request);
    }

    /// <summary>Tests both supported containers, live ACL refresh, fresh starts and protected child creation.</summary>
    public static void QualifyStateContainers(string fixture)
    {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        QualifyContainerPolicy(sid);
        foreach (bool profileRoot in new bool[] { false, true })
        {
            string profile = Path.Combine(fixture, profileRoot ? "profile-root" : "local-root");
            Directory.CreateDirectory(profile, ContainerFixtureAcl(sid, false));
            string local = Path.Combine(profile, "AppData", "Local");
            Directory.CreateDirectory(local);
            using (Owner owner = new Owner(sid, local, profile))
            {
                string root = profileRoot ? owner.ProfileRoot : owner.Root;
                using (OpenPath(owner, root, true, true)) { }
                string lease = OpenContainerFixture(owner, root);
                Directory.SetAccessControl(root, ContainerFixtureAcl(sid, true));
                string before = Directory
                    .GetAccessControl(root)
                    .GetSecurityDescriptorSddlForm(AccessControlSections.Access);
                if (DefaultStateRoot(owner) != root)
                    throw new InvalidOperationException("State root changed");
                ContainerLeaf(owner, lease, "write");
                if ((string)ContainerLeaf(owner, lease, "read")["dataBase64"] != "dGVzdA==")
                    throw new InvalidOperationException("State contents changed");
                ContainerLeaf(owner, lease, "list");
                using (Owner restarted = new Owner(sid, local, profile))
                {
                    if (DefaultStateRoot(restarted) != root)
                        throw new InvalidOperationException("Restart abandoned state");
                    using (OpenPath(restarted, root, true, false)) { }
                }

                string file = Path.Combine(root, "fixture.json");
                ArtifactMetadata artifact = InstallArtifact(
                    owner,
                    GetLease(owner, lease),
                    "nerva-connector.mjs",
                    file,
                    128,
                    4,
                    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                    false
                );
                if (artifact.SizeBytes != 4)
                    throw new InvalidOperationException("Artifact contents changed");
                ValidateDescriptor(
                    new RawSecurityDescriptor(
                        File.GetAccessControl(Path.Combine(root, "nerva-connector.mjs"))
                            .GetSecurityDescriptorBinaryForm(),
                        0
                    ),
                    true,
                    sid
                );
                FileSecurity privateFile = File.GetAccessControl(file);
                ValidateDescriptor(
                    new RawSecurityDescriptor(privateFile.GetSecurityDescriptorBinaryForm(), 0),
                    true,
                    sid
                );
                privateFile.AddAccessRule(
                    new FileSystemAccessRule(
                        new SecurityIdentifier(ContainerReader),
                        FileSystemRights.Read,
                        AccessControlType.Allow
                    )
                );
                File.SetAccessControl(file, privateFile);
                RejectContainerPolicy(
                    delegate
                    {
                        ContainerLeaf(owner, lease, "read");
                    }
                );

                string child = Path.Combine(root, "state");
                using (OpenPath(owner, child, true, true)) { }
                ValidateDirectoryDescriptor(
                    new RawSecurityDescriptor(
                        Directory.GetAccessControl(child).GetSecurityDescriptorBinaryForm(),
                        0
                    ),
                    true,
                    sid
                );
                Directory.SetAccessControl(child, ContainerFixtureAcl(sid, true));
                RejectContainerPolicy(
                    delegate
                    {
                        using (OpenPath(owner, child, true, false)) { }
                    }
                );
                Directory.SetAccessControl(child, ContainerFixtureAcl(sid, false));
                if (
                    before
                    != Directory
                        .GetAccessControl(root)
                        .GetSecurityDescriptorSddlForm(AccessControlSections.Access)
                )
                    throw new InvalidOperationException("Validation rewrote container ACL");

                DirectorySecurity writable = ContainerFixtureAcl(sid, true);
                writable.AddAccessRule(
                    new FileSystemAccessRule(
                        new SecurityIdentifier(ContainerReader),
                        FileSystemRights.WriteData,
                        AccessControlType.Allow
                    )
                );
                Directory.SetAccessControl(root, writable);
                RejectContainerPolicy(
                    delegate
                    {
                        ContainerLeaf(owner, lease, "list");
                    }
                );
                RejectContainerPolicy(
                    delegate
                    {
                        using (OpenPath(owner, root, true, false)) { }
                    }
                );
            }
        }
    }
}

/// <summary>Runs only against the temporary directory supplied by the test harness.</summary>
public static class WindowsStateContainerFixture
{
    public static void Main(string[] arguments)
    {
        if (arguments.Length != 1)
            throw new ArgumentException("Expected an isolated fixture directory");
        NexaConnectorStateOwner.QualifyStateContainers(arguments[0]);
        Console.WriteLine("windows-state-containers-qualified");
    }
}
