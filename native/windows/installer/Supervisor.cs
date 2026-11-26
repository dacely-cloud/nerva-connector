// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

/// <summary>The notification-area icon, the connector process and the update checks, all on the UI thread.</summary>
internal sealed partial class NexaConnectorSupervisor : ApplicationContext
{
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(1);
    private readonly string directory;
    private readonly string self;
    private readonly Control ui = new Control();
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly Icon smallIcon;
    private readonly Icon largeIcon;
    private readonly ToolStripMenuItem startAtSignIn = new ToolStripMenuItem(
        "Start when I sign in"
    );
    private readonly System.Windows.Forms.Timer hider = new System.Windows.Forms.Timer();
    private readonly System.Windows.Forms.Timer finder = new System.Windows.Forms.Timer();
    private readonly System.Windows.Forms.Timer restartTimer = new System.Windows.Forms.Timer();
    private readonly NexaConnectorSupervisorLog log;
    private readonly System.Windows.Forms.Timer checks;
    private IntPtr process = IntPtr.Zero;
    private int processId;
    private IntPtr window = IntPtr.Zero;
    private bool showWhenFound;
    private bool quitting;
    private string pendingUpdate;
    private bool checking;
    private bool notifyUpdateCheck;
    private bool replyToUpdateCheck;
    private readonly string updateEvent =
        NexaConnectorUpdateCommand.EventPrefix + Guid.NewGuid().ToString("N");
    private readonly NexaConnectorUpdateCommand.Replies updateReplies;
    private int failures;
    private DateTime started;
    private int findAttempts;

    internal NexaConnectorSupervisor(string directory, string self, bool open, bool checkOnLaunch)
    {
        this.directory = directory;
        this.self = self;
        string data = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Nerva Connector"
        );
        log = NexaConnectorSupervisorLog.ForCurrentUser();
        NexaConnectorSupervisorUpdates.Clean(data);
        ui.CreateControl();
        IntPtr unused = ui.Handle;
        GC.KeepAlive(unused);
        using (
            Stream icon = Assembly
                .GetExecutingAssembly()
                .GetManifestResourceStream("NexaConnector.Icon")
        )
        {
            smallIcon = new Icon(icon, SystemInformation.SmallIconSize);
        }
        using (
            Stream icon = Assembly
                .GetExecutingAssembly()
                .GetManifestResourceStream("NexaConnector.Icon")
        )
        {
            largeIcon = new Icon(icon, SystemInformation.IconSize);
        }
        ContextMenuStrip menu = new ContextMenuStrip();
        ToolStripMenuItem openItem = new ToolStripMenuItem(
            "Open Nerva Connector",
            null,
            delegate
            {
                Show();
            }
        );
        openItem.Font = new Font(openItem.Font, FontStyle.Bold);
        menu.Items.Add(openItem);
        if (NexaConnectorSupervisorUpdates.Configured)
        {
            menu.Items.Add(
                new ToolStripMenuItem(
                    "Check for updates",
                    null,
                    delegate
                    {
                        Check(true);
                    }
                )
            );
        }
        menu.Items.Add(new ToolStripSeparator());
        startAtSignIn.Click += delegate
        {
            ToggleStartup();
        };
        menu.Items.Add(startAtSignIn);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(
            new ToolStripMenuItem(
                "Quit Nerva Connector",
                null,
                delegate
                {
                    Quit();
                }
            )
        );
        menu.Opening += delegate
        {
            startAtSignIn.Checked = NexaConnectorStartup.Enabled(self);
        };
        tray.ContextMenuStrip = menu;
        tray.Icon = smallIcon;
        tray.Text = "Nerva Connector " + NexaConnectorUpdateSettings.Version;
        tray.MouseClick += delegate(object sender, MouseEventArgs click)
        {
            if (click.Button == MouseButtons.Left)
            {
                Show();
            }
        };
        tray.Visible = true;
        hider.Interval = 300;
        hider.Tick += delegate
        {
            HideIfMinimized();
        };
        hider.Start();
        finder.Interval = 100;
        finder.Tick += delegate
        {
            FindWindow();
        };
        restartTimer.Tick += delegate
        {
            restartTimer.Stop();
            if (!quitting && pendingUpdate == null && process == IntPtr.Zero)
            {
                Start();
            }
        };
        Listen(NexaConnectorSupervisorProgram.ShowEventName, Show);
        Listen(NexaConnectorSupervisorProgram.QuitEventName, Quit);
        if (NexaConnectorSupervisorUpdates.Configured)
        {
            updateReplies = new NexaConnectorUpdateCommand.Replies(updateEvent);
            Listen(
                updateEvent,
                delegate
                {
                    Check(false, true);
                }
            );
        }
        showWhenFound = open;
        Start();
        if (NexaConnectorSupervisorUpdates.Configured)
        {
            checks = new System.Windows.Forms.Timer();
            checks.Interval = (int)CheckInterval.TotalMilliseconds;
            checks.Tick += delegate
            {
                Check(false);
            };
            checks.Start();
            if (checkOnLaunch)
            {
                ui.BeginInvoke(
                    new Action(
                        delegate
                        {
                            Check(false);
                        }
                    )
                );
            }
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (checks != null)
            {
                checks.Dispose();
                updateReplies.Dispose();
            }
            hider.Dispose();
            finder.Dispose();
            restartTimer.Dispose();
            tray.Visible = false;
            tray.Dispose();
            smallIcon.Dispose();
            largeIcon.Dispose();
            ui.Dispose();
        }
        base.Dispose(disposing);
    }

    /// <summary>Toggles background startup at sign-in.</summary>
    private void ToggleStartup()
    {
        bool enabled = !NexaConnectorStartup.Enabled(self);
        NexaConnectorStartup.Set(self, enabled);
        startAtSignIn.Checked = enabled;
    }

    /// <summary>Coalesces tray, console and automatic checks while the update worker runs.</summary>
    private void Check(bool notify, bool reply = false)
    {
        if (quitting || pendingUpdate != null)
        {
            if (reply)
            {
                updateReplies.Send(
                    pendingUpdate != null
                        ? NexaConnectorUpdateCommand.Result.Installing
                        : NexaConnectorUpdateCommand.Result.Failed
                );
            }
            return;
        }
        notifyUpdateCheck |= notify;
        replyToUpdateCheck |= reply;
        if (checking)
        {
            return;
        }
        checking = true;
        ThreadPool.QueueUserWorkItem(
            delegate
            {
                log.Write(
                    "checking for updates (installed " + NexaConnectorUpdateSettings.Version + ")"
                );
                string downloaded = null;
                bool failed = false;
                try
                {
                    downloaded = NexaConnectorSupervisorUpdates.Download(directory, log);
                    if (downloaded == null)
                    {
                        log.Write(
                            "no newer update for " + NexaConnectorUpdateSettings.Architecture
                        );
                    }
                }
                catch (Exception failure)
                {
                    log.Write("update check failed: " + failure.Message);
                    failed = true;
                }
                try
                {
                    ui.BeginInvoke(
                        new Action(
                            delegate
                            {
                                Checked(downloaded, failed);
                            }
                        )
                    );
                }
                catch (InvalidOperationException)
                {
                    /* The supervisor window has already closed. */
                }
            }
        );
    }

    private void Checked(string downloaded, bool failed)
    {
        checking = false;
        bool notify = notifyUpdateCheck;
        bool reply = replyToUpdateCheck;
        notifyUpdateCheck = false;
        replyToUpdateCheck = false;
        if (quitting)
        {
            return;
        }
        if (reply)
        {
            updateReplies.Send(
                failed ? NexaConnectorUpdateCommand.Result.Failed
                : downloaded == null ? NexaConnectorUpdateCommand.Result.Current
                : NexaConnectorUpdateCommand.Result.Installing
            );
        }
        if (notify && downloaded == null)
        {
            tray.ShowBalloonTip(
                5000,
                "Nerva Connector",
                failed
                    ? "Couldn't check for updates. See supervisor.log."
                    : "Nerva Connector is up to date.",
                failed ? ToolTipIcon.Warning : ToolTipIcon.Info
            );
        }
        if (downloaded != null)
        {
            Update(downloaded);
        }
    }

    /// <summary>Stops the connector for a verified setup program; the install starts when it has stopped.</summary>
    private void Update(string setup)
    {
        if (quitting || pendingUpdate != null)
        {
            return;
        }
        log.Write("installing update " + Path.GetFileName(setup));
        pendingUpdate = setup;
        if (process == IntPtr.Zero)
        {
            Install(setup);
        }
        else
        {
            Stop();
        }
    }

    /// <summary>Hands over to setup, which installs silently and starts the new version in the background, then exits.</summary>
    private void Install(string setup)
    {
        try
        {
            ProcessStartInfo start = new ProcessStartInfo(setup, "/S /restart");
            start.UseShellExecute = false;
            start.WorkingDirectory = Path.GetDirectoryName(setup);
            Process.Start(start).Dispose();
        }
        catch (Exception failure)
        {
            log.Write("update setup could not start: " + failure.Message);
            pendingUpdate = null;
            Start();
            return;
        }
        quitting = true;
        tray.Visible = false;
        ExitThread();
    }

    /// <summary>Runs <paramref name="action"/> on the UI thread each time another program signals the named event.</summary>
    private void Listen(string name, Action action)
    {
        EventWaitHandle signal = new EventWaitHandle(false, EventResetMode.AutoReset, name);
        Thread listener = new Thread(
            delegate()
            {
                while (signal.WaitOne())
                {
                    ui.BeginInvoke(action);
                }
            }
        );
        listener.IsBackground = true;
        listener.Start();
    }
}
