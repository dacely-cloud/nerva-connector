// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

/// <summary>
/// "Nerva Connector.exe": keeps the connector running behind an icon in the notification area and keeps it up to date.
/// </summary>
/// <remarks>
/// The connector runs in its own console window, which this program hides and shows: clicking the Nerva icon opens it
/// ready for commands. A foreground launch uses the user's default terminal. A classic console minimizes to the tray
/// and has no close button; /quit in the connector, or Quit in the icon's menu, ends both. A connector that stops with an
/// error is started again after a short wait. Only one copy runs per user: starting another just opens the window.
///
/// With --background it starts without opening the window; the Run value written by /startup, the setup program and
/// the icon's menu starts it that way at sign-in. --startup on, off or status changes or reports that value for the
/// connector, which cannot write the registry itself.
///
/// Updates are checked at startup and every hour, by this program rather than by the connector, so a broken
/// connector still gets the fix. A newer signed setup program is downloaded and checked, the connector is stopped
/// cleanly, and setup installs it silently and starts the new version in the background.
/// </remarks>
public static class NexaConnectorSupervisorProgram
{
    internal const string ShowEventName = @"Local\NervaConnector.Show";
    internal const string QuitEventName = @"Local\NervaConnector.Quit";

    /// <summary>Opens the connector, starts it in the background, or changes the sign-in setting.</summary>
    [STAThread]
    public static int Main(string[] arguments)
    {
        string self = Assembly.GetExecutingAssembly().Location;
        if (arguments.Length == 2 && arguments[0] == "--startup")
        {
            if (arguments[1] == "status")
            {
                return NexaConnectorStartup.Enabled(self) ? 10 : 11;
            }
            if (arguments[1] != "on" && arguments[1] != "off")
            {
                return 87;
            }
            NexaConnectorStartup.Set(self, arguments[1] == "on");
            return 0;
        }
        bool background = arguments.Length == 1 && arguments[0] == "--background";
        if (arguments.Length != 0 && !background)
        {
            return 87;
        }
        bool afterUpdate =
            background && Environment.GetEnvironmentVariable("NERVA_CONNECTOR_AFTER_UPDATE") == "1";
        Environment.SetEnvironmentVariable("NERVA_CONNECTOR_AFTER_UPDATE", null);
        bool created;
        using (Mutex single = new Mutex(true, @"Local\NervaConnector.Supervisor", out created))
        {
            if (!created)
            {
                if (!background)
                {
                    using (
                        EventWaitHandle show = new EventWaitHandle(
                            false,
                            EventResetMode.AutoReset,
                            ShowEventName
                        )
                    )
                    {
                        show.Set();
                    }
                }
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (
                NexaConnectorSupervisor supervisor = new NexaConnectorSupervisor(
                    Path.GetDirectoryName(self),
                    self,
                    !background,
                    !afterUpdate
                )
            )
            {
                Application.Run(supervisor);
            }
            GC.KeepAlive(single);
            return 0;
        }
    }
}
