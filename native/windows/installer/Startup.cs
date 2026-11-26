// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using Microsoft.Win32;

/// <summary>Whether Nerva Connector starts in the background when the user signs in to Windows.</summary>
/// <remarks>
/// One value under the user's Run key holds the choice; the setup program, the background program and the connector's
/// /startup command and setup screens all change this same value, so they always agree. It starts the installed
/// "Nerva Connector.exe" with --background, which waits in the notification area without opening a window.
/// </remarks>
internal static class NexaConnectorStartup
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Nerva Connector";

    /// <summary>The command the Run value holds for <paramref name="launcher"/>.</summary>
    internal static string Command(string launcher)
    {
        return "\"" + Path.GetFullPath(launcher) + "\" --background";
    }

    /// <summary>Whether the Run value starts this exact launcher.</summary>
    internal static bool Enabled(string launcher)
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey))
        {
            string value = key == null ? null : key.GetValue(ValueName) as string;
            return value != null
                && string.Equals(value, Command(launcher), StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>Adds or removes the Run value.</summary>
    internal static void Set(string launcher, bool enabled)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (enabled)
            {
                key.SetValue(ValueName, Command(launcher), RegistryValueKind.String);
            }
            else
            {
                key.DeleteValue(ValueName, false);
            }
        }
    }
}
