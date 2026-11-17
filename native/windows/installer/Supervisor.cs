// SPDX-FileCopyrightText: 2026 Nerva contributors
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
    private static readonly TimeSpan FirstCheck = TimeSpan.FromMinutes(1);
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
    private readonly NexaConnectorSupervisorLog log;
    private readonly NexaConnectorSupervisorNative.ConsoleHandler ignoreControl = delegate(
        uint type
    )
    {
        return true;
    };
    private System.Threading.Timer checks;
    private IntPtr process = IntPtr.Zero;
    private int processId;
    private IntPtr window = IntPtr.Zero;
    private bool showWhenFound;
    private bool quitting;
    private string pendingUpdate;
    private int checking;
    private int interactiveCheck;
    private readonly string updateEvent =
        NexaConnectorUpdateCommand.EventPrefix + Guid.NewGuid().ToString("N");
    private int failures;
    private DateTime started;
    private int findAttempts;

    internal NexaConnectorSupervisor(string directory, string self, bool open)
    {
        this.directory = directory;
        this.self = self;
        string data = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Nerva Connector"
        );
        log = new NexaConnectorSupervisorLog(Path.Combine(data, "Logs", "supervisor.log"));
        NexaConnectorSupervisorUpdates.Clean(data);
        ui.CreateControl();
        IntPtr unused = ui.Handle;
        GC.KeepAlive(unused);
        NexaConnectorSupervisorNative.SetConsoleCtrlHandler(ignoreControl, true);
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
        tray.Text = "Nerva Connector";
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
        Listen(NexaConnectorSupervisorProgram.ShowEventName, Show);
        Listen(NexaConnectorSupervisorProgram.QuitEventName, Quit);
        if (NexaConnectorSupervisorUpdates.Configured)
        {
            Listen(
                updateEvent,
                delegate
                {
                    Check(true);
                }
            );
        }
        showWhenFound = open;
        Start();
        if (NexaConnectorSupervisorUpdates.Configured)
        {
            checks = new System.Threading.Timer(
                delegate
                {
                    Check(false);
                },
                null,
                FirstCheck,
                CheckInterval
            );
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (checks != null)
            {
                checks.Dispose();
            }
            hider.Dispose();
            finder.Dispose();
            tray.Visible = false;
            tray.Dispose();
            smallIcon.Dispose();
            largeIcon.Dispose();
            ui.Dispose();
        }
        base.Dispose(disposing);
    }

    /// <summary>Starts the connector in a new console window that stays hidden until it is shown.</summary>
    private void ToggleStartup()
    {
        bool enabled = !NexaConnectorStartup.Enabled(self);
        NexaConnectorStartup.Set(self, enabled);
        startAtSignIn.Checked = enabled;
    }

    /// <summary>Looks for a newer signed version off the UI thread; an interactive check reports its result.</summary>
    private void Check(bool interactive)
    {
        if (interactive)
        {
            Interlocked.Exchange(ref interactiveCheck, 1);
        }
        if (Interlocked.Exchange(ref checking, 1) == 1)
        {
            return;
        }
        if (quitting || pendingUpdate != null)
        {
            Interlocked.Exchange(ref checking, 0);
            return;
        }
        ThreadPool.QueueUserWorkItem(
            delegate
            {
                string downloaded = null;
                bool failed = false;
                try
                {
                    downloaded = NexaConnectorSupervisorUpdates.Download(log);
                }
                catch (Exception failure)
                {
                    log.Write("update check failed: " + failure.Message);
                    failed = true;
                }
                ui.BeginInvoke(
                    new Action(
                        delegate
                        {
                            try
                            {
                                bool report = Interlocked.Exchange(ref interactiveCheck, 0) == 1;
                                if (report && downloaded == null)
                                {
                                    tray.ShowBalloonTip(
                                        5000,
                                        "Nerva Connector",
                                        failed
                                            ? "Couldn't check for updates. Try again later."
                                            : "Nerva Connector is up to date.",
                                        ToolTipIcon.Info
                                    );
                                }
                                if (downloaded != null)
                                {
                                    Update(downloaded);
                                }
                            }
                            finally
                            {
                                Interlocked.Exchange(ref checking, 0);
                            }
                        }
                    )
                );
            }
        );
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
