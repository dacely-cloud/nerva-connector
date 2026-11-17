// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Reflection;

/// <summary>Extracts a built setup program's payload with the installer's own reader, for tests under Mono.</summary>
public static class NexaConnectorInstallerPayloadFixture
{
    /// <summary>Arguments: the setup program and an empty output directory. Prints the payload version.</summary>
    public static int Main(string[] arguments)
    {
        if (arguments.Length != 2)
        {
            return 87;
        }
        Assembly setup = Assembly.LoadFile(Path.GetFullPath(arguments[0]));
        using (
            Stream payload = setup.GetManifestResourceStream(
                NexaConnectorInstallerPayload.ResourceName
            )
        )
        {
            if (payload == null)
            {
                return 4;
            }
            try
            {
                Console.WriteLine(NexaConnectorInstallerPayload.ReadVersion(payload));
                NexaConnectorInstallerPayload.Extract(payload, arguments[1], null);
                return 0;
            }
            catch (InvalidDataException failure)
            {
                Console.Error.WriteLine(failure.Message);
                return 3;
            }
        }
    }
}
