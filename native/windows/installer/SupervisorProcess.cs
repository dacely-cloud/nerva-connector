// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

/// <summary>Owns connector process startup, console discovery, shutdown and restart on the supervisor UI thread.</summary>
internal sealed partial class NexaConnectorSupervisor : ApplicationContext
{
    private void Start()
    {
        string node = Path.Combine(directory, "node.exe");
        string application = Path.Combine(directory, "nerva-connector.mjs");
        if (!File.Exists(node) || !File.Exists(application))
        {
            log.Write("connector files are missing");
            tray.ShowBalloonTip(
                10000,
                "Nerva Connector",
                "Nerva Connector is incomplete. Run its setup program again to repair it.",
                ToolTipIcon.Error
            );
            return;
        }
        Environment.SetEnvironmentVariable("NODE_OPTIONS", null);
        Environment.SetEnvironmentVariable("NODE_PATH", null);
        Environment.SetEnvironmentVariable("NERVA_CONNECTOR_SUPERVISOR", self);
        Environment.SetEnvironmentVariable(
            "NERVA_CONNECTOR_UPDATE_EVENT",
            NexaConnectorSupervisorUpdates.Configured ? updateEvent : null
        );
        // New connector processes must receive Ctrl+C even if the supervisor stopped an earlier one.
        NexaConnectorSupervisorNative.SetConsoleCtrlHandler(IntPtr.Zero, false);
        NexaConnectorSupervisorNative.StartupInfo startup =
            new NexaConnectorSupervisorNative.StartupInfo();
        startup.cb = Marshal.SizeOf(typeof(NexaConnectorSupervisorNative.StartupInfo));
        startup.lpTitle = "Nerva Connector";
        // A hidden launch keeps Windows from handing this window to the default terminal.
        // The tray supervisor shows its own window once the close button has been disabled.
        startup.dwFlags = NexaConnectorSupervisorNative.UseShowWindow;
        startup.wShowWindow = NexaConnectorSupervisorNative.HideWindow;
        NexaConnectorSupervisorNative.ProcessInformation created;
        StringBuilder command = new StringBuilder(
            "\"" + node + "\" \"" + application + "\" connector"
        );
        if (
            !NexaConnectorSupervisorNative.CreateProcessW(
                node,
                command,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                NexaConnectorSupervisorNative.CreateNewConsole,
                IntPtr.Zero,
                directory,
                ref startup,
                out created
            )
        )
        {
            log.Write("connector start failed: " + Marshal.GetLastWin32Error().ToString());
            Restart();
            return;
        }
        NexaConnectorSupervisorNative.CloseHandle(created.hThread);
        process = created.hProcess;
        processId = created.dwProcessId;
        started = DateTime.UtcNow;
        window = IntPtr.Zero;
        findAttempts = 0;
        finder.Start();
        IntPtr watched = process;
        Thread waiter = new Thread(
            delegate()
            {
                NexaConnectorSupervisorNative.WaitForSingleObject(watched, 0xFFFFFFFF);
                uint code;
                if (!NexaConnectorSupervisorNative.GetExitCodeProcess(watched, out code))
                {
                    code = 1;
                }
                ui.BeginInvoke(
                    new Action(
                        delegate
                        {
                            Exited(watched, code);
                        }
                    )
                );
            }
        );
        waiter.IsBackground = true;
        waiter.Start();
        log.Write("connector started");
    }

    /// <summary>Finds the connector's window, disables its close button and applies the app icon.</summary>
    private void FindWindow()
    {
        if (process == IntPtr.Zero || findAttempts++ > 100)
        {
            finder.Stop();
            return;
        }
        IntPtr found = IntPtr.Zero;
        if (NexaConnectorSupervisorNative.AttachConsole(processId))
        {
            found = NexaConnectorSupervisorNative.GetConsoleWindow();
            NexaConnectorSupervisorNative.FreeConsole();
        }
        if (found == IntPtr.Zero)
        {
            return;
        }
        finder.Stop();
        window = found;
        IntPtr system = NexaConnectorSupervisorNative.GetSystemMenu(window, false);
        if (system != IntPtr.Zero)
        {
            NexaConnectorSupervisorNative.DeleteMenu(system, 0xF060, 0);
            NexaConnectorSupervisorNative.DrawMenuBar(window);
        }
        NexaConnectorSupervisorNative.SendMessage(window, 0x80, new IntPtr(0), smallIcon.Handle);
        NexaConnectorSupervisorNative.SendMessage(window, 0x80, new IntPtr(1), largeIcon.Handle);
        if (showWhenFound)
        {
            Show();
        }
    }

    /// <summary>Opens the connector window in front, starting the connector first if it is not running.</summary>
    private void Show()
    {
        if (quitting || pendingUpdate != null)
        {
            return;
        }
        if (process == IntPtr.Zero)
        {
            showWhenFound = true;
            failures = 0;
            Start();
            return;
        }
        if (window == IntPtr.Zero)
        {
            showWhenFound = true;
            return;
        }
        showWhenFound = false;
        NexaConnectorSupervisorNative.ShowWindow(
            window,
            NexaConnectorSupervisorNative.IsIconic(window) ? 9 : 5
        );
        NexaConnectorSupervisorNative.SetForegroundWindow(window);
    }

    private void HideIfMinimized()
    {
        if (
            window != IntPtr.Zero
            && NexaConnectorSupervisorNative.IsWindowVisible(window)
            && NexaConnectorSupervisorNative.IsIconic(window)
        )
        {
            NexaConnectorSupervisorNative.ShowWindow(window, 0);
        }
    }

    /// <summary>Asks the connector to stop the way Ctrl+C does, and ends it if it has not stopped after ten seconds.</summary>
    private void Stop()
    {
        if (process == IntPtr.Zero)
        {
            return;
        }
        if (NexaConnectorSupervisorNative.AttachConsole(processId))
        {
            try
            {
                // Windows delivers Ctrl+C asynchronously. Ignore it at process level because
                // detaching the console clears registered callbacks before they may have run.
                if (
                    !NexaConnectorSupervisorNative.SetConsoleCtrlHandler(IntPtr.Zero, true)
                    || !NexaConnectorSupervisorNative.GenerateConsoleCtrlEvent(0, 0)
                )
                {
                    log.Write(
                        "could not signal connector shutdown: " + Marshal.GetLastWin32Error()
                    );
                }
            }
            finally
            {
                NexaConnectorSupervisorNative.FreeConsole();
            }
        }
        IntPtr stopping = process;
        System.Windows.Forms.Timer deadline = new System.Windows.Forms.Timer();
        deadline.Interval = 10000;
        deadline.Tick += delegate
        {
            deadline.Dispose();
            if (process == stopping)
            {
                log.Write("connector did not stop; ending it");
                NexaConnectorSupervisorNative.TerminateProcess(stopping, 1);
            }
        };
        deadline.Start();
    }

    private void Exited(IntPtr ended, uint code)
    {
        if (ended != process)
        {
            return;
        }
        NexaConnectorSupervisorNative.CloseHandle(process);
        process = IntPtr.Zero;
        window = IntPtr.Zero;
        finder.Stop();
        log.Write("connector stopped with code " + code.ToString());
        if (pendingUpdate != null)
        {
            Install(pendingUpdate);
            return;
        }
        if (quitting || code == 0)
        {
            ExitThread();
            return;
        }
        Restart();
    }

    /// <summary>Starts the connector again after 5 seconds, doubling up to a minute while it keeps stopping soon after it starts.</summary>
    private void Restart()
    {
        failures =
            DateTime.UtcNow - started > TimeSpan.FromMinutes(2) ? 1 : Math.Min(failures + 1, 5);
        System.Windows.Forms.Timer wait = new System.Windows.Forms.Timer();
        wait.Interval = (int)Math.Min(60000, 5000 * Math.Pow(2, failures - 1));
        wait.Tick += delegate
        {
            wait.Dispose();
            if (!quitting && pendingUpdate == null && process == IntPtr.Zero)
            {
                Start();
            }
        };
        wait.Start();
    }

    private void Quit()
    {
        if (quitting)
        {
            return;
        }
        quitting = true;
        tray.Visible = false;
        if (process == IntPtr.Zero)
        {
            ExitThread();
        }
        else
        {
            Stop();
        }
    }
}
