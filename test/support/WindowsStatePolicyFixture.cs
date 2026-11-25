// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

/// <summary>Portable policy checks; intentionally exercises no Windows filesystem or token API.</summary>
public static class WindowsStatePolicyFixture
{
    private const string User = "S-1-5-21-101-202-303-1001";
    private const string Foreign = "S-1-5-21-101-202-303-1002";
    private const string PrivateAcl =
        "O:" + User + "G:SYD:P(A;OICI;FA;;;" + User + ")(A;OICI;FA;;;SY)";
    private static int assertions;

    private static void Reject(Action operation)
    {
        bool rejected = false;
        try
        {
            operation();
        }
        catch (Exception)
        {
            rejected = true;
        }
        if (!rejected)
        {
            throw new Exception("Unsafe policy was accepted");
        }
        assertions++;
    }

    private static void Accept(Action operation)
    {
        operation();
        assertions++;
    }

    private static RawSecurityDescriptor Descriptor(string sddl)
    {
        return new RawSecurityDescriptor(sddl);
    }

    public static void Main()
    {
        Accept(
            delegate
            {
                if (
                    NexaConnectorStateOwner.ValidateVolumeTarget(@"\Device\HarddiskVolume1")
                    != @"\Device\HarddiskVolume1\"
                )
                {
                    throw new Exception("Incorrect volume anchor");
                }
            }
        );
        foreach (
            string mapping in new string[]
            {
                @"\??\C:",
                @"\??\C:\other",
                @"\Device\Mup\server\share",
                @"\Device\HarddiskVolume1\other",
                @"\Device\HarddiskVolume1:stream",
                @"\Device\HarddiskVolume",
                "\\Device\\HarddiskVolume1\n",
                @"\Device\HarddiskVolume1\..",
            }
        )
        {
            Reject(
                delegate
                {
                    NexaConnectorStateOwner.ValidateVolumeTarget(mapping);
                }
            );
        }
        foreach (
            string name in new string[]
            {
                "device-key.json",
                "pairing-state",
                "authority-public.json",
                "state.partial",
                "safe-子",
            }
        )
        {
            Accept(
                delegate
                {
                    NexaConnectorStateOwner.ValidateLeaf(name);
                }
            );
        }
        foreach (
            string name in new string[]
            {
                "",
                ".",
                "..",
                "a/b",
                "a\\b",
                "state:stream",
                "state.",
                "state ",
                "CON",
                "con.txt",
                "PRN",
                "AUX",
                "NUL",
                "COM1",
                "LPT9",
                "COM¹",
                "CONIN$",
                "CONOUT$",
                "CLOCK$",
                "x\0y",
                "\ud800",
            }
        )
        {
            Reject(
                delegate
                {
                    NexaConnectorStateOwner.ValidateLeaf(name);
                }
            );
        }

        Accept(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(Descriptor(PrivateAcl), true, User);
            }
        );
        Accept(
            delegate
            {
                NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                    Descriptor(PrivateAcl),
                    true,
                    User
                );
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(
                    Descriptor(PrivateAcl.Replace("O:" + User, "O:" + Foreign)),
                    true,
                    User
                );
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(
                    Descriptor(PrivateAcl.Replace("D:P", "D:")),
                    true,
                    User
                );
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(
                    Descriptor(PrivateAcl.Replace("(A;OICI;FA;;;SY)", "")),
                    true,
                    User
                );
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(
                    Descriptor(PrivateAcl + "(A;;FR;;;WD)"),
                    true,
                    User
                );
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(
                    Descriptor(PrivateAcl + "(A;ID;FR;;;" + User + ")"),
                    true,
                    User
                );
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(
                    Descriptor(PrivateAcl + "(A;IO;FR;;;WD)"),
                    true,
                    User
                );
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(
                    new RawSecurityDescriptor(
                        ControlFlags.SelfRelative,
                        new SecurityIdentifier(User),
                        null,
                        null,
                        null
                    ),
                    true,
                    User
                );
            }
        );

        string publicAcl = "O:" + User + "G:SYD:(A;;FA;;;" + User + ")(A;;FA;;;SY)(A;;FR;;;WD)";
        Accept(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(Descriptor(publicAcl), false, User);
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(
                    Descriptor(publicAcl + "(A;;FW;;;WD)"),
                    false,
                    User
                );
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(
                    Descriptor(publicAcl + "(A;;0x4;;;WD)"),
                    false,
                    User
                );
            }
        );
        Accept(
            delegate
            {
                NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                    Descriptor(publicAcl + "(A;;0x4;;;WD)"),
                    false,
                    User
                );
            }
        );
        Accept(
            delegate
            {
                NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                    Descriptor(publicAcl + "(A;;0x2;;;WD)"),
                    false,
                    User
                );
            }
        );
        foreach (
            string mask in new string[]
            {
                "0x40",
                "0x100",
                "0x10000",
                "0x40000",
                "0x80000",
                "GA",
                "GW",
            }
        )
        {
            Reject(
                delegate
                {
                    NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                        Descriptor(publicAcl + "(A;;" + mask + ";;;WD)"),
                        false,
                        User
                    );
                }
            );
        }
        foreach (
            string sandbox in new string[]
            {
                "S-1-15-2-1",
                "S-1-15-2-2",
                "S-1-15-2-3624051433-2125758914-1423191267-1740899205-1073925389-3782572162-737981194",
                "S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681",
            }
        )
        {
            Accept(
                delegate
                {
                    NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                        Descriptor(publicAcl + "(A;OICI;FA;;;" + sandbox + ")"),
                        false,
                        User
                    );
                }
            );
            Accept(
                delegate
                {
                    NexaConnectorStateOwner.ValidateDescriptor(
                        Descriptor(publicAcl + "(A;OICI;FA;;;" + sandbox + ")"),
                        false,
                        User
                    );
                }
            );
            Reject(
                delegate
                {
                    NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                        Descriptor(PrivateAcl + "(A;OICI;FR;;;" + sandbox + ")"),
                        true,
                        User
                    );
                }
            );
            Reject(
                delegate
                {
                    NexaConnectorStateOwner.ValidateDescriptor(
                        Descriptor(PrivateAcl + "(A;;FR;;;" + sandbox + ")"),
                        true,
                        User
                    );
                }
            );
        }
        foreach (
            string mask in new string[]
            {
                "0x1200a9",
                "FR",
                "FX",
                "GRGX",
                "0x1",
                "0x20",
                "0x2",
                "0x4",
                "0x10",
                "0x40",
                "0x100",
                "0x10000",
                "0x40000",
                "0x80000",
                "0x1000000",
                "0x2000000",
                "0x1200ab",
                "FW",
                "GW",
                "GA",
                "FA",
            }
        )
        {
            foreach (string flags in new string[] { "", "OICI", "OICIIO" })
            {
                string grant = "(A;" + flags + ";" + mask + ";;;" + Foreign + ")";
                Reject(
                    delegate
                    {
                        NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                            Descriptor(PrivateAcl + grant),
                            true,
                            User
                        );
                    }
                );
                Reject(
                    delegate
                    {
                        NexaConnectorStateOwner.ValidateDescriptor(
                            Descriptor(PrivateAcl + grant),
                            true,
                            User
                        );
                    }
                );
            }
        }
        foreach (
            string entry in new string[]
            {
                "(A;ID;FR;;;" + Foreign + ")",
                "(A;OICIID;FR;;;" + Foreign + ")",
                "(D;;FR;;;" + Foreign + ")",
                "(A;IO;FA;;;" + User + ")",
            }
        )
        {
            Reject(
                delegate
                {
                    NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                        Descriptor(PrivateAcl + entry),
                        true,
                        User
                    );
                }
            );
        }
        foreach (
            string acl in new string[]
            {
                PrivateAcl.Replace("D:P", "D:"),
                PrivateAcl.Replace("(A;OICI;FA;;;SY)", ""),
                PrivateAcl.Replace("O:" + User, "O:" + Foreign),
            }
        )
        {
            Reject(
                delegate
                {
                    NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                        Descriptor(acl + "(A;OICI;FR;;;" + Foreign + ")"),
                        true,
                        User
                    );
                }
            );
        }
        foreach (
            string foreign in new string[] { "S-1-15-1", "S-1-15-21-1", "S-1-5-32-545", "S-1-1-0" }
        )
        {
            Reject(
                delegate
                {
                    NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                        Descriptor(publicAcl + "(A;OICI;FA;;;" + foreign + ")"),
                        false,
                        User
                    );
                }
            );
        }

        RawAcl objectAcl = new RawAcl(GenericAcl.AclRevisionDS, 1);
        objectAcl.InsertAce(
            0,
            new ObjectAce(
                AceFlags.None,
                AceQualifier.AccessAllowed,
                0x40000,
                new SecurityIdentifier(Foreign),
                ObjectAceFlags.ObjectAceTypePresent,
                Guid.NewGuid(),
                Guid.Empty,
                false,
                null
            )
        );
        RawSecurityDescriptor objectDescriptor = new RawSecurityDescriptor(
            ControlFlags.DiscretionaryAclPresent | ControlFlags.SelfRelative,
            new SecurityIdentifier(User),
            null,
            null,
            objectAcl
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(objectDescriptor, false, User);
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDirectoryDescriptor(objectDescriptor, false, User);
            }
        );

        RawAcl callbackAcl = new RawAcl(GenericAcl.AclRevision, 1);
        callbackAcl.InsertAce(
            0,
            new CommonAce(
                AceFlags.None,
                AceQualifier.AccessAllowed,
                0x40000,
                new SecurityIdentifier(Foreign),
                true,
                new byte[4]
            )
        );
        RawSecurityDescriptor callbackDescriptor = new RawSecurityDescriptor(
            ControlFlags.DiscretionaryAclPresent | ControlFlags.SelfRelative,
            new SecurityIdentifier(User),
            null,
            null,
            callbackAcl
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDescriptor(callbackDescriptor, false, User);
            }
        );
        Reject(
            delegate
            {
                NexaConnectorStateOwner.ValidateDirectoryDescriptor(
                    callbackDescriptor,
                    false,
                    User
                );
            }
        );
        foreach (uint vendor in new uint[] { 0x10DE, 0x1002, 0x8086, 0x1234 })
        {
            Accept(
                delegate
                {
                    NexaConnectorGpuInventory.Description description =
                        new NexaConnectorGpuInventory.Description
                        {
                            Name = " Test adapter ",
                            VendorId = vendor,
                            LuidHigh = -1,
                            LuidLow = 42,
                            DedicatedVideoMemory = new UIntPtr(34359738368UL),
                            SharedSystemMemory = new UIntPtr(68719476736UL),
                        };
                    Dictionary<string, object> device = NexaConnectorGpuInventory.Device(
                        description
                    );
                    string expected =
                        vendor == 0x10DE ? "nvidia"
                        : vendor == 0x1002 ? "amd"
                        : vendor == 0x8086 ? "intel"
                        : "other";
                    if (
                        (string)device["vendor"] != expected
                        || (string)device["model"] != "Test adapter"
                        || (string)device["id"] != "DXGI-FFFFFFFF-0000002A"
                        || (string)device["totalVramBytes"] != "34359738368"
                        || device["availableVramBytes"] != null
                    )
                    {
                        throw new Exception("Invalid GPU descriptor conversion");
                    }
                }
            );
        }
        Accept(
            delegate
            {
                if (
                    Marshal
                        .OffsetOf(
                            typeof(NexaConnectorGpuInventory.Description),
                            "DedicatedVideoMemory"
                        )
                        .ToInt32() != 272
                    || Marshal.SizeOf(typeof(NexaConnectorGpuInventory.Description))
                        != (IntPtr.Size == 8 ? 312 : 296)
                )
                {
                    throw new Exception("DXGI descriptor layout mismatch");
                }
                NexaConnectorGpuInventory.Description integrated =
                    new NexaConnectorGpuInventory.Description
                    {
                        Name = "Intel integrated",
                        VendorId = 0x8086,
                        SharedSystemMemory = new UIntPtr(68719476736UL),
                    };
                Dictionary<string, object> device = NexaConnectorGpuInventory.Device(integrated);
                if ((string)device["totalVramBytes"] != "0" || device["availableVramBytes"] != null)
                {
                    throw new Exception("Shared memory was mislabeled as dedicated VRAM");
                }
            }
        );
        Reject(
            delegate
            {
                NexaConnectorGpuInventory.Device(
                    new NexaConnectorGpuInventory.Description { Name = "GPU\nname" }
                );
            }
        );
        Console.WriteLine("windows-state-policy-checks=" + assertions.ToString());
    }
}
