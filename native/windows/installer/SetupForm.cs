// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

/// <summary>The setup destination, options and installation progress share one window.</summary>
internal sealed class NexaConnectorSetupForm : Form
{
    private readonly Stream payload;
    private readonly CheckBox desktop = new CheckBox();
    private readonly CheckBox startup = new CheckBox();
    private readonly CheckBox open = new CheckBox();
    private readonly TextBox directory = new TextBox();
    private readonly Button browse = new Button();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly Label status = new Label();
    private readonly Button action = new Button();
    private readonly Button cancel = new Button();
    private bool installing;
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
        Stream logo = Assembly
            .GetExecutingAssembly()
            .GetManifestResourceStream("NexaConnector.Logo");
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
        titles.Controls.Add(
            Caption(
                "Nerva Connector",
                new Font(Font.FontFamily, Font.Size * 1.6f, FontStyle.Bold),
                Color.Black
            )
        );
        titles.Controls.Add(
            Caption("Lets Nexa use this computer when you ask it to.", Font, Color.DimGray)
        );
        header.Controls.Add(titles);
        page.Controls.Add(header);

        page.Controls.Add(
            Caption(
                installed == null
                    ? "Installs for "
                        + Environment.UserName
                        + ". Choose a writable folder below. No administrator rights needed."
                    : "Version "
                        + installed
                        + " is installed. This updates it and keeps this computer's link and settings.",
                Font,
                Color.Black
            )
        );

        page.Controls.Add(Caption("Installation folder", Font, Color.Black));
        FlowLayoutPanel location = new FlowLayoutPanel();
        location.AutoSize = true;
        location.WrapContents = false;
        location.Margin = new Padding(0, 6, 0, 12);
        directory.Width = 340;
        directory.Text = NexaConnectorSetupLayout.Folder;
        directory.AccessibleName = "Installation folder";
        browse.Text = "Browse...";
        browse.AutoSize = true;
        browse.Click += delegate
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "Choose an empty folder for Nerva Connector";
                dialog.ShowNewFolderButton = true;
                if (Directory.Exists(directory.Text))
                {
                    dialog.SelectedPath = directory.Text;
                }
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    directory.Text = dialog.SelectedPath;
                }
            }
        };
        location.Controls.Add(directory);
        location.Controls.Add(browse);
        page.Controls.Add(location);

        Choice(desktop, "Add a desktop shortcut", true);
        Choice(
            startup,
            "Start Nerva Connector in the background when I sign in",
            NexaConnectorSetupLayout.StartsAtSignIn
        );
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
        cancel.Click += delegate
        {
            Close();
        };
        action.Text = installed == null ? "Install" : "Update";
        action.AutoSize = true;
        action.Click += delegate
        {
            Act();
        };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(action);
        page.Controls.Add(buttons);

        Controls.Add(page);
        AcceptButton = action;
        CancelButton = cancel;
    }

    /// <summary>Keeps the payload and staging owner alive until the installation worker has finished.</summary>
    protected override void OnFormClosing(FormClosingEventArgs closing)
    {
        if (installing)
        {
            closing.Cancel = true;
            return;
        }
        base.OnFormClosing(closing);
    }

    private void Act()
    {
        if (finished)
        {
            Close();
            return;
        }
        NexaConnectorSetupChoices choices = new NexaConnectorSetupChoices();
        try
        {
            choices.InstallDirectory = NexaConnectorSetupDirectory.ValidateChoice(directory.Text);
        }
        catch (ArgumentException error)
        {
            status.ForeColor = Color.Firebrick;
            status.Text = error.Message;
            directory.Focus();
            return;
        }
        choices.DesktopShortcut = desktop.Checked;
        choices.StartAtSignIn = startup.Checked;
        choices.OpenWhenDone = open.Checked;
        foreach (
            Control control in new Control[]
            {
                directory,
                browse,
                desktop,
                startup,
                open,
                action,
                cancel,
            }
        )
        {
            control.Enabled = false;
        }
        progress.Visible = true;
        progress.Value = 0;
        status.ForeColor = Color.Black;
        status.Text = "Installing...";
        BackgroundWorker worker = new BackgroundWorker();
        worker.WorkerReportsProgress = true;
        worker.DoWork += delegate
        {
            payload.Position = 0;
            NexaConnectorSetup.Install(
                payload,
                choices,
                delegate(int done, int total)
                {
                    worker.ReportProgress(done * 100 / total);
                }
            );
        };
        worker.ProgressChanged += delegate(object sender, ProgressChangedEventArgs change)
        {
            progress.Value = change.ProgressPercentage;
        };
        worker.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs result)
        {
            installing = false;
            worker.Dispose();
            if (result.Error != null)
            {
                progress.Visible = false;
                status.ForeColor = Color.Firebrick;
                status.Text = result.Error.Message;
                foreach (
                    Control control in new Control[]
                    {
                        directory,
                        browse,
                        desktop,
                        startup,
                        open,
                        action,
                        cancel,
                    }
                )
                {
                    control.Enabled = true;
                }
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
            status.Text =
                "Nerva Connector is installed. Open it from the Start menu"
                + (choices.DesktopShortcut ? " or your desktop." : ".");
            action.Text = "Finish";
            action.Enabled = true;
            cancel.Visible = false;
        };
        installing = true;
        try
        {
            worker.RunWorkerAsync();
        }
        catch
        {
            installing = false;
            worker.Dispose();
            throw;
        }
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
