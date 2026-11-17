// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;

/// <summary>Exercises path validation and actual staged publication without registry or desktop APIs.</summary>
public static class WindowsSetupDirectoryFixture
{
    private static int assertions;
    private static readonly NexaConnectorPayloadFile[] Files =
    {
        new NexaConnectorPayloadFile { Name = "node.exe" },
    };

    public static void Main(string[] arguments)
    {
        foreach (
            string path in new string[]
            {
                @"C:\Apps\Nerva Connector",
                @"D:\Nerva",
                @"E:\子 App",
                @"C:\Apps\COM10",
                @"C:\Apps\Company",
            }
        )
        {
            Equal(NexaConnectorSetupDirectory.ValidateChoice(path), path);
        }
        foreach (
            string path in new string[]
            {
                null,
                "",
                @"C:\",
                @"C:relative",
                @"\\server\share\App",
                @"C:\Apps\..\Other",
                @"C:\Apps\.",
                @"C:\Apps\trailing.",
                @"C:\Apps\trailing ",
                @"C:\Apps\CON.txt",
                @"C:\Apps\LPT1",
                @"C:\Apps\COM¹",
                @"C:\Apps\LPT².txt",
                @"C:\Apps\lpt³",
                @"C:\Apps\CON .txt",
                @"C:\Apps\file:stream",
                "C:\\Apps\\bad\nname",
                @"C:\Apps\" + new string('x', 201),
            }
        )
        {
            Reject(
                delegate
                {
                    NexaConnectorSetupDirectory.ValidateChoice(path);
                }
            );
        }

        string root = arguments[0];
        string target = Path.Combine(root, "custom install");
        using (NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(target, false))
        {
            File.WriteAllText(Path.Combine(install.Staging, "node.exe"), "new runtime");
            install.Publish(Files);
        }
        Equal(File.ReadAllText(Path.Combine(target, "node.exe")), "new runtime");
        Equal(Directory.GetDirectories(root).Length, 1);

        using (NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(target, true))
        {
            File.WriteAllText(Path.Combine(install.Staging, "node.exe"), "updated runtime");
            install.Publish(Files);
        }
        Equal(File.ReadAllText(Path.Combine(target, "node.exe")), "updated runtime");
        Equal(Directory.GetDirectories(root).Length, 1);

        using (NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(target, false))
        {
            File.WriteAllText(Path.Combine(install.Staging, "node.exe"), "recovered runtime");
            install.Publish(Files);
        }
        Equal(File.ReadAllText(Path.Combine(target, "node.exe")), "recovered runtime");
        string unrelated = Path.Combine(root, "unregistered");
        Directory.CreateDirectory(unrelated);
        File.WriteAllText(Path.Combine(unrelated, "node.exe"), "user runtime");
        Reject(
            delegate
            {
                using (
                    NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(
                        unrelated,
                        false
                    )
                )
                {
                    throw new Exception("An unrelated folder was accepted before staging.");
                }
            }
        );
        Equal(File.ReadAllText(Path.Combine(unrelated, "node.exe")), "user runtime");
        Equal(Directory.GetDirectories(root).Length, 2);
        Directory.Delete(unrelated, true);

        CheckCaseAlias(target);

        string existingFile = Path.Combine(root, "existing-file");
        File.WriteAllText(existingFile, "user file");
        Reject(
            delegate
            {
                using (
                    NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(
                        existingFile,
                        false
                    )
                )
                {
                    throw new Exception("A file was accepted as an installation folder.");
                }
            }
        );
        Equal(File.ReadAllText(existingFile), "user file");
        Equal(Directory.GetDirectories(root).Length, 1);
        File.WriteAllText(Path.Combine(target, "my-project.txt"), "user data");
        using (NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(target, true))
        {
            File.WriteAllText(Path.Combine(install.Staging, "node.exe"), "must not replace");
            Reject(
                delegate
                {
                    install.Publish(Files);
                }
            );
        }
        Equal(File.ReadAllText(Path.Combine(target, "my-project.txt")), "user data");
        Equal(File.ReadAllText(Path.Combine(target, "node.exe")), "recovered runtime");
        Equal(Directory.GetDirectories(root).Length, 1);

        string canceled = Path.Combine(root, "cancelled");
        using (
            NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(canceled, false)
        )
        {
            File.WriteAllText(Path.Combine(install.Staging, "partial.exe"), "partial");
        }
        Equal(Directory.Exists(canceled), false);
        Equal(Directory.GetDirectories(root).Length, 1);

        string nestedParent = Path.Combine(root, "new-parent");
        string nested = Path.Combine(nestedParent, "another-parent", "cancelled");
        using (NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(nested, false))
        {
            File.WriteAllText(Path.Combine(install.Staging, "partial.exe"), "partial");
        }
        Equal(Directory.Exists(nestedParent), false);
        Equal(Directory.GetDirectories(root).Length, 1);

        string retainedParent = Path.Combine(root, "retained-parent");
        using (
            NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(
                Path.Combine(retainedParent, "cancelled"),
                false
            )
        )
        {
            File.WriteAllText(Path.Combine(retainedParent, "my-project.txt"), "user data");
        }
        Equal(File.ReadAllText(Path.Combine(retainedParent, "my-project.txt")), "user data");
        Equal(Directory.GetDirectories(retainedParent).Length, 0);

        if (arguments.Length == 2)
        {
            foreach (string link in new string[] { "linked-parent", "dangling" })
            {
                string linked = Path.Combine(arguments[1], link, "install");
                Reject(
                    delegate
                    {
                        using (
                            NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(
                                linked,
                                false
                            )
                        )
                        {
                            throw new Exception("A linked parent was accepted before staging.");
                        }
                    }
                );
            }
            Equal(
                Directory.GetFileSystemEntries(Path.Combine(arguments[1], "destination")).Length,
                0
            );
        }
        Console.WriteLine("windows-setup-directory-checks=" + assertions);
    }

    private static void CheckCaseAlias(string target)
    {
        string alias = Path.Combine(target, "NODE.EXE");
        if (File.Exists(alias))
        {
            return;
        }
        File.WriteAllText(alias, "case-sensitive user file");
        using (NexaConnectorSetupDirectory install = new NexaConnectorSetupDirectory(target, true))
        {
            File.WriteAllText(Path.Combine(install.Staging, "node.exe"), "must not replace");
            Reject(
                delegate
                {
                    install.Publish(Files);
                }
            );
        }
        Equal(File.ReadAllText(alias), "case-sensitive user file");
        Equal(File.ReadAllText(Path.Combine(target, "node.exe")), "recovered runtime");
        File.Delete(alias);
    }

    private static void Reject(Action operation)
    {
        bool rejected = false;
        try
        {
            operation();
        }
        catch (ArgumentException)
        {
            rejected = true;
        }
        catch (IOException)
        {
            rejected = true;
        }
        Equal(rejected, true);
    }

    private static void Equal(object actual, object expected)
    {
        if (!Object.Equals(actual, expected))
        {
            throw new Exception("Setup directory result changed");
        }
        assertions++;
    }
}
