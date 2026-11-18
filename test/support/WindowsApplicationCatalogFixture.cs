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
        if (!VersionFamilies())
            return 8;
        Console.WriteLine(
            "NERVA_APPLICATION_CATALOG exact_names=true whitespace=true browsers=true ambiguity_preserved=true newest_regular_version=true"
        );
        return 0;
    }

    private static bool VersionFamilies()
    {
        List<NexaConnectorApplicationEntry> catalog = new List<NexaConnectorApplicationEntry>();
        foreach (string version in new[] { "1.8.1.0", "2.1.1.2", "2.2.5.2", "1.9.7.0" })
        {
            catalog.Add(Entry("grandMA3 onPC " + version, version));
            catalog.Add(Entry("grandMA3 onPC " + version + " Clean Start", version + "-clean"));
            catalog.Add(Entry("grandMA3 " + version + " Terminal", version + "-terminal"));
        }
        if (
            !Selects(catalog, "grandma 3", "2.2.5.2")
            || !Selects(catalog, "grandma3 onpc", "2.2.5.2")
            || !Selects(catalog, "grandMA3 onPC 1.8.1.0", "1.8.1.0")
            || !Selects(catalog, "grandMA3 onPC 2.2.5.2 Clean Start", "2.2.5.2-clean")
        )
            return false;
        catalog.Add(Entry("grandMA3 onPC 2.2.5.2", "other-registration"));
        if (NexaConnectorHostApplicationCatalog.Select("grandma3", catalog).Count != catalog.Count)
            return false;
        catalog.RemoveAt(catalog.Count - 1);

        // Beyond the response limit, a higher version can still win and an unrelated match still blocks it.
        for (int patch = 0; patch < 33; patch++)
        {
            string version = "2.10." + patch.ToString();
            catalog.Add(Entry("grandMA3 onPC " + version, version));
        }
        if (!Selects(catalog, "grandma3", "2.10.32"))
            return false;
        catalog.Add(Entry("grandMA3 Visualizer", "visualizer"));
        return NexaConnectorHostApplicationCatalog.Select("grandma3", catalog).Count == 32
            && NexaConnectorHostApplicationCatalog
                .Select(
                    "grandma3",
                    new List<NexaConnectorApplicationEntry>
                    {
                        Entry("grandMA3 2.2.5.2 Terminal", "terminal"),
                    }
                )
                .Count == 0;
    }

    private static bool Selects(
        List<NexaConnectorApplicationEntry> catalog,
        string query,
        string id
    )
    {
        List<NexaConnectorApplicationEntry> result = NexaConnectorHostApplicationCatalog.Select(
            query,
            catalog
        );
        return result.Count == 1 && result[0].Id == id;
    }

    private static NexaConnectorApplicationEntry Entry(string name, string id)
    {
        return new NexaConnectorApplicationEntry { Name = name, Id = id };
    }
}
