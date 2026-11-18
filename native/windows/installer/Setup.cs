// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

/// <summary>
/// Nerva Connector setup for one Windows user, without administrator rights.
/// </summary>
/// <remarks>
/// The setup program carries the connector, its native helpers, node.exe and the launcher as one embedded payload.
/// It installs into %LOCALAPPDATA%\Programs\Nerva Connector, adds a Start menu entry and optionally a desktop shortcut
/// and a sign-in shortcut, and registers in Settings, Apps. Files are written to a staging folder and checked before
/// they replace an earlier installation, so an update never leaves a half-written program. The connector's own data,
/// this computer's link and settings, lives elsewhere and is never touched, so updating or reinstalling reconnects.
/// A standard NSIS uninstaller removes only program files. /S installs silently; /D= selects a custom folder.
/// </remarks>
public static class NexaConnectorSetup
{
    /// <summary>Installs interactively or with /S; /D= selects an explicit installation folder.</summary>
    [STAThread]
    public static int Main(string[] arguments)
    {
        bool silent = false;
        string directory = null;
        bool restart = false;
        foreach (string argument in arguments)
        {
            if (string.Equals(argument, "/S", StringComparison.OrdinalIgnoreCase))
            {
                silent = true;
            }
            else if (
                argument.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)
                && directory == null
            )
            {
                directory = argument.Substring(3);
            }
            else if (string.Equals(argument, "/restart", StringComparison.OrdinalIgnoreCase))
            {
                restart = true;
            }
            else
            {
                return 87;
            }
        }
        try
        {
            SetProcessDPIAware();
        }
        catch (EntryPointNotFoundException)
        {
            /* Older Windows scales the window itself. */
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (directory != null)
        {
            try
            {
                NexaConnectorSetupLayout.SelectFolder(directory);
            }
            catch (ArgumentException error)
            {
                if (!silent)
                {
                    MessageBox.Show(
                        error.Message,
                        "Nerva Connector Setup",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                }
                return 87;
            }
        }
        Stream payload = Assembly
            .GetExecutingAssembly()
            .GetManifestResourceStream(NexaConnectorInstallerPayload.ResourceName);
        if (payload == null)
        {
            if (!silent)
            {
                MessageBox.Show(
                    "The setup payload is missing. Download the installer again.",
                    "Nerva Connector Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            return 1;
        }
        using (payload)
        {
            if (silent)
            {
                int code = 0;
                try
                {
                    NexaConnectorSetupChoices choices = new NexaConnectorSetupChoices();
                    choices.OpenWhenDone = false;
                    choices.DesktopShortcut =
                        File.Exists(NexaConnectorSetupLayout.DesktopShortcut)
                        || NexaConnectorSetupLayout.InstalledVersion() == null;
                    choices.StartAtSignIn = NexaConnectorSetupLayout.StartsAtSignIn;
                    Install(payload, choices, null);
                }
                catch (Exception failure)
                {
                    NexaConnectorSupervisorLog
                        .ForCurrentUser()
                        .Write("silent setup failed: " + failure.Message);
                    code = 1;
                }
                if (restart && File.Exists(NexaConnectorSetupLayout.Launcher))
                {
                    Launch(true, true);
                }
                return code;
            }
            Application.Run(new NexaConnectorSetupForm(payload));
            return 0;
        }
    }

    /// <summary>Writes the program, its shortcuts and its Apps entry; throws with a message a person can act on.</summary>
    internal static void Install(
        Stream payload,
        NexaConnectorSetupChoices choices,
        Action<int, int> progress
    )
    {
        string version = NexaConnectorInstallerPayload.ReadVersion(payload);
        string target = NexaConnectorSetupDirectory.ValidateChoice(choices.InstallDirectory);
        NexaConnectorSetupLayout.SelectFolder(target);
        List<NexaConnectorPayloadFile> files;
        using (
            NexaConnectorSetupDirectory installation = new NexaConnectorSetupDirectory(
                target,
                NexaConnectorSetupLayout.IsRegisteredFolder(target)
            )
        )
        {
            if (!NexaConnectorSetupLayout.Stop())
            {
                throw new InvalidOperationException(
                    "Nerva Connector is still running. Quit it from its icon in the notification area, then try again."
                );
            }
            files = NexaConnectorInstallerPayload.Extract(payload, installation.Staging, progress);
            installation.Publish(files);
        }
        string launcher = NexaConnectorSetupLayout.Launcher;
        const string description = "Connect this computer to Nexa";
        NexaConnectorShortcut.Create(
            NexaConnectorSetupLayout.StartMenuShortcut,
            launcher,
            description
        );
        if (choices.DesktopShortcut)
        {
            NexaConnectorShortcut.Create(
                NexaConnectorSetupLayout.DesktopShortcut,
                launcher,
                description
            );
        }
        else
        {
            NexaConnectorShortcut.Remove(NexaConnectorSetupLayout.DesktopShortcut);
        }
        NexaConnectorShortcut.Remove(NexaConnectorSetupLayout.StartupShortcut);
        NexaConnectorStartup.Set(launcher, choices.StartAtSignIn);
        long bytes = 0;
        foreach (NexaConnectorPayloadFile file in files)
        {
            bytes += file.Size;
        }
        using (
            RegistryKey key = Registry.CurrentUser.CreateSubKey(
                NexaConnectorSetupLayout.UninstallKey
            )
        )
        {
            key.SetValue("DisplayName", NexaConnectorSetupLayout.Name);
            key.SetValue("DisplayVersion", version);
            key.SetValue("Publisher", "Nerva");
            key.SetValue("DisplayIcon", launcher + ",0");
            key.SetValue("InstallLocation", target);
            key.SetValue("URLInfoAbout", "https://nervalabs.com");
            key.SetValue("UninstallString", "\"" + NexaConnectorSetupLayout.Uninstaller + "\"");
            key.SetValue(
                "QuietUninstallString",
                "\"" + NexaConnectorSetupLayout.Uninstaller + "\" /S"
            );
            key.SetValue(
                "EstimatedSize",
                (int)Math.Min(int.MaxValue, bytes / 1024),
                RegistryValueKind.DWord
            );
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    /// <summary>Starts the installed Nerva Connector, in the background or with its window open.</summary>
    internal static void Launch(bool background, bool afterUpdate = false)
    {
        ProcessStartInfo start = new ProcessStartInfo(
            NexaConnectorSetupLayout.Launcher,
            background ? "--background" : ""
        );
        start.UseShellExecute = false;
        start.WorkingDirectory = NexaConnectorSetupLayout.Folder;
        if (afterUpdate)
        {
            start.EnvironmentVariables["NERVA_CONNECTOR_AFTER_UPDATE"] = "1";
        }
        Process.Start(start).Dispose();
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDPIAware();
}
