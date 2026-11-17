// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

/// <summary>The choices a person makes on the setup screen.</summary>
internal sealed class NexaConnectorSetupChoices
{
    internal bool DesktopShortcut = true;
    internal bool StartAtSignIn;
    internal bool OpenWhenDone = true;
}

/// <summary>Where Nerva Connector lives for the current Windows user.</summary>
internal static class NexaConnectorSetupLayout
{
    internal const string Name = "Nerva Connector";
    internal const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\NervaConnector";

    internal static string Folder
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name); }
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
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name + ".lnk"); }
    }

    internal static string DesktopShortcut
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Name + ".lnk"); }
    }

    /// <summary>The sign-in shortcut the first setup program made; Startup.cs's Run value replaces it, so it is removed.</summary>
    internal static string StartupShortcut
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), Name + ".lnk"); }
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
        if (!Running()) return true;
        using (EventWaitHandle quit = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\NervaConnector.Quit")) quit.Set();
        for (int attempt = 0; attempt < 120; attempt++)
        {
            Thread.Sleep(250);
            if (!Running()) return true;
        }
        return false;
    }

    /// <summary>Whether the installed connector is open: a running program's file cannot be opened for writing.</summary>
    internal static bool Running()
    {
        foreach (string file in new string[] { Launcher, Path.Combine(Folder, "node.exe") })
        {
            if (!File.Exists(file)) continue;
            try
            {
                using (new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            }
            catch (IOException)
            {
                return true;
            }
            catch (UnauthorizedAccessException)
            {
                return true;
            }
        }
        return false;
    }
}

/// <summary>
/// Nerva Connector setup and uninstall for one Windows user, without administrator rights.
/// </summary>
/// <remarks>
/// The setup program carries the connector, its native helpers, node.exe and the launcher as one embedded payload.
/// It installs into %LOCALAPPDATA%\Programs\Nerva Connector, adds a Start menu entry and optionally a desktop shortcut
/// and a sign-in shortcut, and registers in Settings, Apps. Files are written to a staging folder and checked before
/// they replace an earlier installation, so an update never leaves a half-written program. The connector's own data,
/// this computer's link and settings, lives elsewhere and is never touched, so updating or reinstalling reconnects.
/// The same program without a payload is the uninstaller. /S installs or uninstalls without asking.
/// </remarks>
public static class NexaConnectorSetup
{
    /// <summary>Installs, or uninstalls with /uninstall or when no payload is embedded.</summary>
    [STAThread]
    public static int Main(string[] arguments)
    {
        bool silent = false;
        bool uninstall = false;
        bool restart = false;
        foreach (string argument in arguments)
        {
            if (string.Equals(argument, "/S", StringComparison.OrdinalIgnoreCase)) silent = true;
            else if (string.Equals(argument, "/uninstall", StringComparison.OrdinalIgnoreCase)) uninstall = true;
            else if (string.Equals(argument, "/restart", StringComparison.OrdinalIgnoreCase)) restart = true;
            else return 87;
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
        Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(NexaConnectorInstallerPayload.ResourceName);
        if (uninstall || payload == null)
        {
            return Uninstall(silent);
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
                    choices.DesktopShortcut = File.Exists(NexaConnectorSetupLayout.DesktopShortcut) || NexaConnectorSetupLayout.InstalledVersion() == null;
                    choices.StartAtSignIn = NexaConnectorStartup.Enabled(NexaConnectorSetupLayout.Launcher);
                    Install(payload, choices, null);
                }
                catch (Exception)
                {
                    code = 1;
                }
                if (restart && File.Exists(NexaConnectorSetupLayout.Launcher)) Launch(true);
                return code;
            }
            Application.Run(new NexaConnectorSetupForm(payload));
            return 0;
        }
    }

    /// <summary>Writes the program, its shortcuts and its Apps entry; throws with a message a person can act on.</summary>
    internal static void Install(Stream payload, NexaConnectorSetupChoices choices, Action<int, int> progress)
    {
        string version = NexaConnectorInstallerPayload.ReadVersion(payload);
        if (!NexaConnectorSetupLayout.Stop())
        {
            throw new InvalidOperationException("Nerva Connector is still running. Quit it from its icon in the notification area, then try again.");
        }
        string target = NexaConnectorSetupLayout.Folder;
        string staging = target + ".new";
        string previous = target + ".old";
        DeleteDirectory(staging);
        DeleteDirectory(previous);
        Directory.CreateDirectory(staging);
        List<NexaConnectorPayloadFile> files;
        try
        {
            files = NexaConnectorInstallerPayload.Extract(payload, staging, progress);
        }
        catch
        {
            DeleteDirectory(staging);
            throw;
        }
        if (Directory.Exists(target))
        {
            try
            {
                Directory.Move(target, previous);
            }
            catch (IOException)
            {
                DeleteDirectory(staging);
                throw new InvalidOperationException("Nerva Connector is still running. Quit it from its icon in the notification area, then try again.");
            }
        }
        try
        {
            Directory.Move(staging, target);
        }
        catch
        {
            if (Directory.Exists(previous) && !Directory.Exists(target)) Directory.Move(previous, target);
            throw;
        }
        DeleteDirectory(previous);
        string launcher = NexaConnectorSetupLayout.Launcher;
        const string description = "Connect this computer to Nexa";
        NexaConnectorShortcut.Create(NexaConnectorSetupLayout.StartMenuShortcut, launcher, description);
        if (choices.DesktopShortcut) NexaConnectorShortcut.Create(NexaConnectorSetupLayout.DesktopShortcut, launcher, description);
        else NexaConnectorShortcut.Remove(NexaConnectorSetupLayout.DesktopShortcut);
        NexaConnectorShortcut.Remove(NexaConnectorSetupLayout.StartupShortcut);
        NexaConnectorStartup.Set(launcher, choices.StartAtSignIn);
        long bytes = 0;
        foreach (NexaConnectorPayloadFile file in files) bytes += file.Size;
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(NexaConnectorSetupLayout.UninstallKey))
        {
            key.SetValue("DisplayName", NexaConnectorSetupLayout.Name);
            key.SetValue("DisplayVersion", version);
            key.SetValue("Publisher", "Nerva");
            key.SetValue("DisplayIcon", launcher + ",0");
            key.SetValue("InstallLocation", target);
            key.SetValue("URLInfoAbout", "https://nervalabs.com");
            key.SetValue("UninstallString", "\"" + NexaConnectorSetupLayout.Uninstaller + "\" /uninstall");
            key.SetValue("QuietUninstallString", "\"" + NexaConnectorSetupLayout.Uninstaller + "\" /uninstall /S");
            key.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, bytes / 1024), RegistryValueKind.DWord);
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    /// <summary>Starts the installed Nerva Connector, in the background or with its window open.</summary>
    internal static void Launch(bool background)
    {
        ProcessStartInfo start = new ProcessStartInfo(NexaConnectorSetupLayout.Launcher, background ? "--background" : "");
        start.UseShellExecute = false;
        start.WorkingDirectory = NexaConnectorSetupLayout.Folder;
        Process.Start(start).Dispose();
    }

    private static int Uninstall(bool silent)
    {
        const string title = "Uninstall Nerva Connector";
        if (!silent && MessageBox.Show(
            "Remove Nerva Connector from this computer?\n\nThis computer stays linked to your Nerva account and keeps its settings, so installing again reconnects it. To unlink it as well, open Nerva Connector first and type /logout.",
            title, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
        {
            return 1;
        }
        if (!NexaConnectorSetupLayout.Stop())
        {
            if (!silent) MessageBox.Show("Nerva Connector is still running. Quit it from its icon in the notification area, then uninstall again.", title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        NexaConnectorStartup.Set(NexaConnectorSetupLayout.Launcher, false);
        NexaConnectorShortcut.Remove(NexaConnectorSetupLayout.StartMenuShortcut);
        NexaConnectorShortcut.Remove(NexaConnectorSetupLayout.DesktopShortcut);
        NexaConnectorShortcut.Remove(NexaConnectorSetupLayout.StartupShortcut);
        Registry.CurrentUser.DeleteSubKeyTree(NexaConnectorSetupLayout.UninstallKey, false);
        string directory = NexaConnectorSetupLayout.Folder;
        string self = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
        if (self.StartsWith(Path.GetFullPath(directory) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            ProcessStartInfo removal = new ProcessStartInfo(
                Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                "/d /c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + directory + "\"");
            removal.CreateNoWindow = true;
            removal.UseShellExecute = false;
            removal.WorkingDirectory = Path.GetTempPath();
            Process.Start(removal).Dispose();
        }
        else
        {
            DeleteDirectory(directory);
        }
        if (!silent) MessageBox.Show("Nerva Connector was removed.", title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }

    private static void DeleteDirectory(string path)
    {
        if (Directory.Exists(path)) Directory.Delete(path, true);
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDPIAware();
}

/// <summary>The one setup window: what gets installed, three choices, progress, then done.</summary>
internal sealed class NexaConnectorSetupForm : Form
{
    private readonly Stream payload;
    private readonly CheckBox desktop = new CheckBox();
    private readonly CheckBox startup = new CheckBox();
    private readonly CheckBox open = new CheckBox();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly Label status = new Label();
    private readonly Button action = new Button();
    private readonly Button cancel = new Button();
    private bool finished;

    internal NexaConnectorSetupForm(Stream payload)
    {
        this.payload = payload;
        string installed = NexaConnectorSetupLayout.InstalledVersion();
        AutoScaleDimensions = new SizeF(96f, 96f);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = "Nerva Connector Setup";
        Font = SystemFonts.MessageBoxFont;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        BackColor = Color.White;
        try
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch (ArgumentException)
        {
            /* The window keeps the default icon. */
        }

        FlowLayoutPanel page = new FlowLayoutPanel();
        page.FlowDirection = FlowDirection.TopDown;
        page.AutoSize = true;
        page.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        page.Padding = new Padding(24, 20, 24, 12);
        page.WrapContents = false;

        FlowLayoutPanel header = new FlowLayoutPanel();
        header.AutoSize = true;
        header.WrapContents = false;
        header.Margin = new Padding(0, 0, 0, 12);
        Stream logo = Assembly.GetExecutingAssembly().GetManifestResourceStream("NexaConnector.Logo");
        if (logo != null)
        {
            PictureBox picture = new PictureBox();
            picture.Image = Image.FromStream(logo);
            picture.SizeMode = PictureBoxSizeMode.Zoom;
            picture.Size = new Size(56, 56);
            picture.Margin = new Padding(0, 0, 14, 0);
            header.Controls.Add(picture);
        }
        FlowLayoutPanel titles = new FlowLayoutPanel();
        titles.FlowDirection = FlowDirection.TopDown;
        titles.AutoSize = true;
        titles.WrapContents = false;
        titles.Margin = new Padding(0, 6, 0, 0);
        titles.Controls.Add(Caption("Nerva Connector", new Font(Font.FontFamily, Font.Size * 1.6f, FontStyle.Bold), Color.Black));
        titles.Controls.Add(Caption("Lets Nexa use this computer when you ask it to.", Font, Color.DimGray));
        header.Controls.Add(titles);
        page.Controls.Add(header);

        page.Controls.Add(Caption(installed == null
            ? "Installs for " + Environment.UserName + " in " + NexaConnectorSetupLayout.Folder + ". No administrator rights needed."
            : "Version " + installed + " is installed. This updates it and keeps this computer's link and settings.",
            Font, Color.Black));

        Choice(desktop, "Add a desktop shortcut", true);
        Choice(startup, "Start Nerva Connector in the background when I sign in", NexaConnectorStartup.Enabled(NexaConnectorSetupLayout.Launcher));
        Choice(open, "Open Nerva Connector when setup finishes", true);
        page.Controls.Add(desktop);
        page.Controls.Add(startup);
        page.Controls.Add(open);

        progress.Width = 440;
        progress.Visible = false;
        progress.Margin = new Padding(0, 14, 0, 0);
        page.Controls.Add(progress);
        status.AutoSize = true;
        status.MaximumSize = new Size(440, 0);
        status.Margin = new Padding(0, 8, 0, 0);
        page.Controls.Add(status);

        FlowLayoutPanel buttons = new FlowLayoutPanel();
        buttons.FlowDirection = FlowDirection.RightToLeft;
        buttons.AutoSize = true;
        buttons.Width = 440;
        buttons.Margin = new Padding(0, 16, 0, 0);
        cancel.Text = "Cancel";
        cancel.AutoSize = true;
        cancel.Click += delegate { Close(); };
        action.Text = installed == null ? "Install" : "Update";
        action.AutoSize = true;
        action.Click += delegate { Act(); };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(action);
        page.Controls.Add(buttons);

        Controls.Add(page);
        AcceptButton = action;
        CancelButton = cancel;
    }

    private void Act()
    {
        if (finished)
        {
            Close();
            return;
        }
        NexaConnectorSetupChoices choices = new NexaConnectorSetupChoices();
        choices.DesktopShortcut = desktop.Checked;
        choices.StartAtSignIn = startup.Checked;
        choices.OpenWhenDone = open.Checked;
        foreach (Control control in new Control[] { desktop, startup, open, action, cancel }) control.Enabled = false;
        progress.Visible = true;
        progress.Value = 0;
        status.ForeColor = Color.Black;
        status.Text = "Installing...";
        BackgroundWorker worker = new BackgroundWorker();
        worker.WorkerReportsProgress = true;
        worker.DoWork += delegate
        {
            payload.Position = 0;
            NexaConnectorSetup.Install(payload, choices, delegate(int done, int total) { worker.ReportProgress(done * 100 / total); });
        };
        worker.ProgressChanged += delegate(object sender, ProgressChangedEventArgs change) { progress.Value = change.ProgressPercentage; };
        worker.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs result)
        {
            if (result.Error != null)
            {
                progress.Visible = false;
                status.ForeColor = Color.Firebrick;
                status.Text = result.Error.Message;
                foreach (Control control in new Control[] { desktop, startup, open, action, cancel }) control.Enabled = true;
                return;
            }
            if (choices.OpenWhenDone || choices.StartAtSignIn)
            {
                NexaConnectorSetup.Launch(!choices.OpenWhenDone);
            }
            if (choices.OpenWhenDone)
            {
                Close();
                return;
            }
            finished = true;
            progress.Value = 100;
            status.Text = "Nerva Connector is installed. Open it from the Start menu" + (choices.DesktopShortcut ? " or your desktop." : ".");
            action.Text = "Finish";
            action.Enabled = true;
            cancel.Visible = false;
        };
        worker.RunWorkerAsync();
    }

    private static void Choice(CheckBox box, string text, bool value)
    {
        box.Text = text;
        box.Checked = value;
        box.AutoSize = true;
        box.Margin = new Padding(0, 8, 0, 0);
    }

    private static Label Caption(string text, Font font, Color color)
    {
        Label label = new Label();
        label.Text = text;
        label.Font = font;
        label.ForeColor = color;
        label.AutoSize = true;
        label.MaximumSize = new Size(440, 0);
        label.Margin = new Padding(0, 0, 0, 4);
        return label;
    }
}
