// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;

/// <summary>Portable managed checks deliberately invoke no Windows API.</summary>
internal static class WindowsSandboxPolicyFixture
{
    private static int checks;

    public static int Main()
    {
        SandboxPolicy.Layout();
        checks++;
        Equal(SandboxPolicy.Quote("simple"), "\"simple\"");
        Equal(SandboxPolicy.Quote("C:\\folder with spaces\\"), "\"C:\\folder with spaces\\\\\"");
        Equal(SandboxPolicy.Quote("embedded\"quote"), "\"embedded\\\"quote\"");
        Equal(SandboxPolicy.Quote("slash\\\"quote"), "\"slash\\\\\\\"quote\"");
        foreach (string value in new string[] { "", "x\0y", "x\ny", "x\ry", new string('x', 4097) })
        {
            Reject(
                delegate
                {
                    SandboxPolicy.Quote(value);
                }
            );
        }
        Equal(SandboxPolicy.Profile(new string('a', 32)), "nexa.qualifier." + new string('a', 32));
        foreach (
            string value in new string[]
            {
                "",
                "x",
                new string('a', 31),
                new string('a', 33),
                new string('A', 32),
                "../other",
                "a\n",
            }
        )
        {
            Reject(
                delegate
                {
                    SandboxPolicy.Profile(value);
                }
            );
        }
        if (SandboxPolicy.Handle("4") != new IntPtr(4))
        {
            throw new Exception("valid handle");
        }
        checks++;
        foreach (
            string value in new string[]
            {
                "0",
                "1",
                "-1",
                "00",
                "04",
                "4 ",
                " 4",
                "4\n",
                "18446744073709551616",
            }
        )
        {
            Reject(
                delegate
                {
                    SandboxPolicy.Handle(value);
                }
            );
        }
        Check(
            (SandboxPolicy.JobFlags & 0x270E) == 0x270E
                && (SandboxPolicy.JobFlags & 0x1800) == 0
                && SandboxPolicy.WallMilliseconds <= 5000
                && SandboxPolicy.MemoryBytes == 134217728
                && SandboxPolicy.CpuTicks == 20000000
        );
        Check(
            (SandboxPolicy.CreationFlags & 0x00080404) == 0x00080404
                && (SandboxPolicy.CreationFlags & 0x01000000) == 0
                && SandboxPolicy.MaximumReport == 512
        );
        Check(SandboxPolicy.ChildCreationDenied(5));
        Check(SandboxPolicy.ChildCreationDenied(367));
        foreach (int code in new int[] { 0, 2, 6, 32, 87, 193, 1290, -1, Int32.MaxValue })
        {
            Check(!SandboxPolicy.ChildCreationDenied(code));
        }
        ImageChecks();
        Console.Out.WriteLine(
            "windows-sandbox-policy-checks="
                + checks.ToString(System.Globalization.CultureInfo.InvariantCulture)
        );
        return 0;
    }

    private static void ImageChecks()
    {
        const string name = @"\Device\HarddiskVolume2\Users\Owner\worker.exe";
        byte[] identifier = new byte[24];
        identifier[0] = 1;
        identifier[8] = 2;
        byte[] snapshot = (byte[])identifier.Clone();
        SandboxImageIdentity original = new SandboxImageIdentity(name, identifier);
        Check(original.Matches(new SandboxImageIdentity(name, snapshot)));
        Check(original.MatchesName(name));
        identifier[0] = 8;
        Check(original.Matches(new SandboxImageIdentity(name, snapshot)));
        foreach (
            string other in new string[]
            {
                @"\Device\HarddiskVolume3\Users\Owner\worker.exe",
                @"\Device\HarddiskVolume2\Users\Owner\WORKER~1.EXE",
                @"\Device\HarddiskVolume2\Users\owner\worker.exe",
                @"\Device\HarddiskVolume2\Users\Owner\other.exe",
                @"C:\Users\Owner\worker.exe",
            }
        )
        {
            Check(!original.MatchesName(other));
        }
        byte[] different = (byte[])snapshot.Clone();
        different[0] = 2;
        Check(!original.Matches(new SandboxImageIdentity(name, different)));
        different = (byte[])snapshot.Clone();
        different[8] = 3;
        Check(!original.Matches(new SandboxImageIdentity(name, different)));
        foreach (
            string invalid in new string[]
            {
                @"C:\Users\Owner\worker.exe",
                @"\??\C:\worker.exe",
                @"\Device\Mup\server\share\worker.exe",
                @"\Device\HarddiskVolume2\folder\..\worker.exe",
                @"\Device\HarddiskVolume2\worker.exe:other",
                @"\Device\HarddiskVolume2\CON.exe",
                @"\Device\HarddiskVolume2\worker.exe\",
                @"\Device\HarddiskVolume2\",
                "\\Device\\HarddiskVolume2\\bad\ud800.exe",
                @"\device\HarddiskVolume2\worker.exe",
            }
        )
        {
            Reject(
                delegate
                {
                    new SandboxImageIdentity(invalid, snapshot);
                }
            );
        }
        foreach (byte[] invalid in new byte[][] { null, new byte[0], new byte[23], new byte[25] })
        {
            Reject(
                delegate
                {
                    new SandboxImageIdentity(name, invalid);
                }
            );
        }
    }

    private static void Check(bool accepted)
    {
        if (!accepted)
        {
            throw new Exception("resource policy");
        }
        checks++;
    }

    private static void Equal(string actual, string expected)
    {
        if (actual != expected)
        {
            throw new Exception("argument encoding");
        }
        checks++;
    }

    private static void Reject(Action action)
    {
        try
        {
            action();
        }
        catch (ArgumentException)
        {
            checks++;
            return;
        }
        throw new Exception("unsafe input accepted");
    }
}
