// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Threading;
using Microsoft.Win32;

/// <summary>Where Nerva Connector lives for the current Windows user.</summary>
internal static class NexaConnectorSetupLayout
{
    private static string selectedFolder;
    internal const string Name = "Nerva Connector";
    internal const string UninstallKey =
        @"Software\Microsoft\Windows\CurrentVersion\Uninstall\NervaConnector";

    internal static string Folder
    {
        get
        {
            if (selectedFolder != null)
            {
                return selectedFolder;
            }
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey))
            {
                string installed = key == null ? null : key.GetValue("InstallLocation") as string;
                if (installed != null)
                {
                    return NexaConnectorSetupDirectory.ValidateChoice(installed);
                }
            }
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                Name
            );
        }
    }

    /// <summary>Applies an explicit UI or command-line destination before setup starts.</summary>
    internal static void SelectFolder(string directory)
    {
        selectedFolder = NexaConnectorSetupDirectory.ValidateChoice(directory);
    }

    internal static bool IsRegisteredFolder(string directory)
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey))
        {
            string installed = key == null ? null : key.GetValue("InstallLocation") as string;
            return String.Equals(installed, directory, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>Retains the registered installation's sign-in choice when selecting a different folder.</summary>
    internal static bool StartsAtSignIn
    {
        get
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey))
            {
                string installed = key == null ? null : key.GetValue("InstallLocation") as string;
                if (installed == null)
                {
                    return false;
                }
                return NexaConnectorStartup.Enabled(
                    Path.Combine(
                        NexaConnectorSetupDirectory.ValidateChoice(installed),
                        Name + ".exe"
                    )
                );
            }
        }
    }

    internal static string Launcher
    {
        get { return Path.Combine(Folder, Name + ".exe"); }
    }

    internal static string Uninstaller
    {
        get { return Path.Combine(Folder, "Uninstall " + Name + ".exe"); }
    }

    internal static string StartMenuShortcut
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                Name + ".lnk"
            );
        }
    }

    internal static string DesktopShortcut
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                Name + ".lnk"
            );
        }
    }

    /// <summary>The sign-in shortcut the first setup program made; Startup.cs's Run value replaces it, so it is removed.</summary>
    internal static string StartupShortcut
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Startup),
                Name + ".lnk"
            );
        }
    }

    /// <summary>The version recorded by a previous installation, or null.</summary>
    internal static string InstalledVersion()
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey))
        {
            return key == null ? null : key.GetValue("DisplayVersion") as string;
        }
    }

    /// <summary>
    /// Asks a running Nerva Connector to quit and waits up to 30 seconds for it to stop.
    /// </summary>
    /// <returns>Whether nothing from the installation is running any more.</returns>
    internal static bool Stop()
    {
        using (Mutex running = new Mutex(false, @"Local\NervaConnector.Supervisor"))
        {
            if (Acquire(running, 0))
            {
                running.ReleaseMutex();
                return true;
            }
            using (
                EventWaitHandle quit = new EventWaitHandle(
                    false,
                    EventResetMode.AutoReset,
                    @"Local\NervaConnector.Quit"
                )
            )
            {
                quit.Set();
            }
            if (Acquire(running, 30000))
            {
                running.ReleaseMutex();
                return true;
            }
            return false;
        }
    }

    private static bool Acquire(Mutex mutex, int milliseconds)
    {
        try
        {
            return mutex.WaitOne(milliseconds);
        }
        catch (AbandonedMutexException)
        {
            return true;
        }
    }
}
