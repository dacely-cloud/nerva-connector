// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;

/// <summary>The actual native bridge consumes one fake installed Node child without creating customer update state.</summary>
internal static class NexaConnectorWindowsUpdateTransportFixture
{
    private static int Main(string[] arguments)
    {
        string directory = arguments[0];
        string destination = Path.Combine(directory, "私の更新.partial");
        NexaConnectorSupervisorLog log = new NexaConnectorSupervisorLog(
            Path.Combine(directory, "supervisor.log")
        );
        try
        {
            NexaConnectorSupervisorUpdateTransport.Fetch(
                directory,
                new Uri("https://updates.example.invalid/fixture"),
                destination,
                32,
                2000,
                "manifest",
                log
            );
            Console.WriteLine("transport=ok");
            return 0;
        }
        catch (Exception error)
        {
            log.Write(error.Message);
            Console.WriteLine(error.Message);
            return 2;
        }
    }
}
