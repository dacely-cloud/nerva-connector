// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;

/// <summary>Resolves a family name only when all matches describe versions of the same desktop app.</summary>
internal static class NexaConnectorHostApplicationVersionFamily
{
    // An empty array trims whitespace and selects the overload available on .NET Framework.
    private static readonly char[] Whitespace = new char[0];

    internal static List<NexaConnectorApplicationEntry> Choose(
        string query,
        List<NexaConnectorApplicationEntry> matches
    )
    {
        NexaConnectorApplicationEntry latest = null;
        Version newest = null;
        string desktopFamily = null;
        bool tied = false;
        foreach (NexaConnectorApplicationEntry entry in matches)
        {
            string name = entry.Name.TrimEnd(Whitespace);
            bool accessory =
                StripSuffix(ref name, " Clean Start") || StripSuffix(ref name, " Terminal");
            int separator = name.LastIndexOf(' ');
            if (separator <= 0)
                return null;

            Version version;
            string number = name.Substring(separator + 1);
            if (!NumericVersion(number) || !Version.TryParse(number, out version))
                return null;

            string family = name.Substring(0, separator).TrimEnd(Whitespace);
            string fullFamily = NexaConnectorHostApplicationCatalog.Compact(family);
            if (
                !Equal(query, fullFamily)
                && !(
                    StripSuffix(ref family, " onPC")
                    && Equal(query, NexaConnectorHostApplicationCatalog.Compact(family))
                )
            )
                return null;
            if (accessory)
                continue;
            if (desktopFamily != null && !Equal(desktopFamily, fullFamily))
                return null;
            desktopFamily = fullFamily;

            int order = newest == null ? 1 : version.CompareTo(newest);
            if (order > 0)
            {
                latest = entry;
                newest = version;
                tied = false;
            }
            else if (order == 0)
            {
                tied = true;
            }
        }

        if (tied)
            return null;
        return latest == null
            ? new List<NexaConnectorApplicationEntry>()
            : new List<NexaConnectorApplicationEntry> { latest };
    }

    private static bool StripSuffix(ref string name, string suffix)
    {
        if (!name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
            return false;
        name = name.Substring(0, name.Length - suffix.Length).TrimEnd(Whitespace);
        return true;
    }

    private static bool Equal(string left, string right)
    {
        return String.Equals(left, right, StringComparison.OrdinalIgnoreCase);
    }

    private static bool NumericVersion(string value)
    {
        if (value.IndexOf('.') < 0)
            return false;
        foreach (char character in value)
        {
            if (character != '.' && (character < '0' || character > '9'))
                return false;
        }
        return true;
    }
}
