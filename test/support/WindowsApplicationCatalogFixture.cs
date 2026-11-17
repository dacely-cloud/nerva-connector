// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;

internal static class NexaConnectorApplicationCatalogFixture
{
    internal static int Main()
    {
        List<NexaConnectorApplicationEntry> catalog = new List<NexaConnectorApplicationEntry>
        {
            new NexaConnectorApplicationEntry { Name = "grandMA3", Id = "grandma-app" },
            new NexaConnectorApplicationEntry
            {
                Name = "grandMA3 onPC 2.2.5.2",
                Id = "grandma-onpc",
            },
            new NexaConnectorApplicationEntry { Name = "Google Chrome", Id = "chrome.exe" },
            new NexaConnectorApplicationEntry { Name = "Firefox", Id = "firefox.exe" },
        };
        if (NexaConnectorHostApplicationCatalog.Select("grandma 3", catalog)[0].Id != "grandma-app")
            return 1;
        if (
            NexaConnectorHostApplicationCatalog.Select("googlechrome", catalog)[0].Id
            != "chrome.exe"
        )
            return 2;
        if (NexaConnectorHostApplicationCatalog.Select("firefox", catalog)[0].Id != "firefox.exe")
            return 3;
        if (NexaConnectorHostApplicationCatalog.Select("grandma", catalog).Count != 2)
            return 4;
        catalog.Add(new NexaConnectorApplicationEntry { Name = "grandMA 3", Id = "another-app" });
        if (NexaConnectorHostApplicationCatalog.Select("grand ma3", catalog).Count != 2)
            return 5;
        if (NexaConnectorHostApplicationCatalog.Select("grandMA3", catalog).Count != 1)
            return 6;
        if (NexaConnectorHostApplicationCatalog.Select("does not exist", catalog).Count != 0)
            return 7;
        Console.WriteLine(
            "NERVA_APPLICATION_CATALOG exact_names=true whitespace=true browsers=true ambiguity_preserved=true"
        );
        return 0;
    }
}
