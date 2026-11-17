// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;

/// <summary>Runs the installed program's update feed check under Mono, for tests.</summary>
public static class NexaConnectorUpdateFeedFixture
{
    /// <summary>
    /// Arguments: latest.json, latest.json.sig, a file holding the public key XML, the architecture and the installed
    /// version. Prints "current", "invalid" or the offered version and file name.
    /// </summary>
    public static int Main(string[] arguments)
    {
        if (arguments.Length != 5)
        {
            return 87;
        }
        try
        {
            NexaConnectorUpdate update = NexaConnectorUpdateFeed.Select(
                File.ReadAllBytes(arguments[0]),
                File.ReadAllText(arguments[1]),
                File.ReadAllText(arguments[2]),
                arguments[3],
                arguments[4]
            );
            Console.WriteLine(
                update == null
                    ? "current"
                    : update.Version
                        + " "
                        + update.Name
                        + " "
                        + update.Size.ToString()
                        + " "
                        + update.Sha256
            );
            return 0;
        }
        catch (InvalidDataException)
        {
            Console.WriteLine("invalid");
            return 0;
        }
    }
}
