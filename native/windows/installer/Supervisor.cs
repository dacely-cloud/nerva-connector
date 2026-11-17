// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

/// <summary>
/// "Nerva Connector.exe": keeps the connector running behind an icon in the notification area and keeps it up to date.
/// </summary>
/// <remarks>
/// The connector runs in its own console window, which this program hides and shows: clicking the Nerva icon opens it
/// ready for commands, and minimizing it hides it again. Its close button is removed so the window cannot end the
/// connector by accident; /quit in the connector, or Quit in the icon's menu, ends both. A connector that stops with an
/// error is started again after a short wait. Only one copy runs per user: starting another just opens the window.
///
/// With --background it starts without opening the window; the Run value written by /startup, the setup program and
/// the icon's menu starts it that way at sign-in. --startup on, off or status changes or reports that value for the
/// connector, which cannot write the registry itself.
///
/// Updates are checked a minute after start and every hour, by this program rather than by the connector, so a broken
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
            if (arguments[1] == "status") return NexaConnectorStartup.Enabled(self) ? 10 : 11;
            if (arguments[1] != "on" && arguments[1] != "off") return 87;
            NexaConnectorStartup.Set(self, arguments[1] == "on");
            return 0;
        }
        bool background = arguments.Length == 1 && arguments[0] == "--background";
        if (arguments.Length != 0 && !background) return 87;
        bool created;
        using (Mutex single = new Mutex(true, @"Local\NervaConnector.Supervisor", out created))
        {
            if (!created)
            {
                if (!background)
                {
                    using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName)) show.Set();
                }
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (NexaConnectorSupervisor supervisor = new NexaConnectorSupervisor(Path.GetDirectoryName(self), self, !background))
            {
                Application.Run(supervisor);
            }
            GC.KeepAlive(single);
            return 0;
        }
    }
}

/// <summary>The notification-area icon, the connector process and the update checks, all on the UI thread.</summary>
internal sealed class NexaConnectorSupervisor : ApplicationContext
{
    private static readonly TimeSpan FirstCheck = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(1);
    private readonly string directory;
    private readonly string self;
    private readonly Control ui = new Control();
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly Icon smallIcon;
    private readonly Icon largeIcon;
    private readonly ToolStripMenuItem startAtSignIn = new ToolStripMenuItem("Start when I sign in");
    private readonly System.Windows.Forms.Timer hider = new System.Windows.Forms.Timer();
    private readonly System.Windows.Forms.Timer finder = new System.Windows.Forms.Timer();
    private readonly NexaConnectorSupervisorLog log;
    private readonly NexaConnectorSupervisorNative.ConsoleHandler ignoreControl = delegate(uint type) { return true; };
    private System.Threading.Timer checks;
    private IntPtr process = IntPtr.Zero;
    private int processId;
    private IntPtr window = IntPtr.Zero;
    private bool showWhenFound;
    private bool quitting;
    private string pendingUpdate;
    private int checking;
    private int failures;
    private DateTime started;
    private int findAttempts;

    internal NexaConnectorSupervisor(string directory, string self, bool open)
    {
        this.directory = directory;
        this.self = self;
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nerva Connector");
        log = new NexaConnectorSupervisorLog(Path.Combine(data, "Logs", "supervisor.log"));
        NexaConnectorSupervisorUpdates.Clean(data);
        ui.CreateControl();
        IntPtr unused = ui.Handle;
        GC.KeepAlive(unused);
        NexaConnectorSupervisorNative.SetConsoleCtrlHandler(ignoreControl, true);
        using (Stream icon = Assembly.GetExecutingAssembly().GetManifestResourceStream("NexaConnector.Icon"))
        {
            smallIcon = new Icon(icon, SystemInformation.SmallIconSize);
        }
        using (Stream icon = Assembly.GetExecutingAssembly().GetManifestResourceStream("NexaConnector.Icon"))
        {
            largeIcon = new Icon(icon, SystemInformation.IconSize);
        }
        ContextMenuStrip menu = new ContextMenuStrip();
        ToolStripMenuItem openItem = new ToolStripMenuItem("Open Nerva Connector", null, delegate { Show(); });
        openItem.Font = new Font(openItem.Font, FontStyle.Bold);
        menu.Items.Add(openItem);
        if (NexaConnectorSupervisorUpdates.Configured)
        {
            menu.Items.Add(new ToolStripMenuItem("Check for updates", null, delegate { Check(true); }));
        }
        menu.Items.Add(new ToolStripSeparator());
        startAtSignIn.Click += delegate { ToggleStartup(); };
        menu.Items.Add(startAtSignIn);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Quit Nerva Connector", null, delegate { Quit(); }));
        menu.Opening += delegate { startAtSignIn.Checked = NexaConnectorStartup.Enabled(self); };
        tray.ContextMenuStrip = menu;
        tray.Icon = smallIcon;
        tray.Text = "Nerva Connector";
        tray.MouseClick += delegate(object sender, MouseEventArgs click) { if (click.Button == MouseButtons.Left) Show(); };
        tray.Visible = true;
        hider.Interval = 300;
        hider.Tick += delegate { HideIfMinimized(); };
        hider.Start();
        finder.Interval = 100;
        finder.Tick += delegate { FindWindow(); };
        Listen(NexaConnectorSupervisorProgram.ShowEventName, Show);
        Listen(NexaConnectorSupervisorProgram.QuitEventName, Quit);
        showWhenFound = open;
        Start();
        if (NexaConnectorSupervisorUpdates.Configured)
        {
            checks = new System.Threading.Timer(delegate { Check(false); }, null, FirstCheck, CheckInterval);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (checks != null) checks.Dispose();
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
    private void Start()
    {
        string node = Path.Combine(directory, "node.exe");
        string application = Path.Combine(directory, "nerva-connector.mjs");
        if (!File.Exists(node) || !File.Exists(application))
        {
            log.Write("connector files are missing");
            tray.ShowBalloonTip(10000, "Nerva Connector", "Nerva Connector is incomplete. Run its setup program again to repair it.", ToolTipIcon.Error);
            return;
        }
        Environment.SetEnvironmentVariable("NODE_OPTIONS", null);
        Environment.SetEnvironmentVariable("NODE_PATH", null);
        Environment.SetEnvironmentVariable("NERVA_CONNECTOR_SUPERVISOR", self);
        NexaConnectorSupervisorNative.StartupInfo startup = new NexaConnectorSupervisorNative.StartupInfo();
        startup.cb = Marshal.SizeOf(typeof(NexaConnectorSupervisorNative.StartupInfo));
        startup.lpTitle = "Nerva Connector";
        startup.dwFlags = 0x1;
        startup.wShowWindow = 0;
        NexaConnectorSupervisorNative.ProcessInformation created;
        StringBuilder command = new StringBuilder("\"" + node + "\" \"" + application + "\" connector");
        if (!NexaConnectorSupervisorNative.CreateProcessW(node, command, IntPtr.Zero, IntPtr.Zero, false, 0x10, IntPtr.Zero, directory, ref startup, out created))
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
        Thread waiter = new Thread(delegate()
        {
            NexaConnectorSupervisorNative.WaitForSingleObject(watched, 0xFFFFFFFF);
            uint code;
            if (!NexaConnectorSupervisorNative.GetExitCodeProcess(watched, out code)) code = 1;
            ui.BeginInvoke(new Action(delegate { Exited(watched, code); }));
        });
        waiter.IsBackground = true;
        waiter.Start();
        log.Write("connector started");
    }

    /// <summary>Finds the connector's console window once it exists, removes its close button and gives it the Nerva icon.</summary>
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
        if (found == IntPtr.Zero) return;
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
        if (showWhenFound) Show();
    }

    /// <summary>Opens the connector window in front, starting the connector first if it is not running.</summary>
    private void Show()
    {
        if (quitting || pendingUpdate != null) return;
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
        NexaConnectorSupervisorNative.ShowWindow(window, NexaConnectorSupervisorNative.IsIconic(window) ? 9 : 5);
        NexaConnectorSupervisorNative.SetForegroundWindow(window);
    }

    private void HideIfMinimized()
    {
        if (window != IntPtr.Zero && NexaConnectorSupervisorNative.IsWindowVisible(window) && NexaConnectorSupervisorNative.IsIconic(window))
        {
            NexaConnectorSupervisorNative.ShowWindow(window, 0);
        }
    }

    /// <summary>Asks the connector to stop the way Ctrl+C does, and ends it if it has not stopped after ten seconds.</summary>
    private void Stop()
    {
        if (process == IntPtr.Zero) return;
        if (NexaConnectorSupervisorNative.AttachConsole(processId))
        {
            NexaConnectorSupervisorNative.GenerateConsoleCtrlEvent(0, 0);
            NexaConnectorSupervisorNative.FreeConsole();
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
        if (ended != process) return;
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
        failures = DateTime.UtcNow - started > TimeSpan.FromMinutes(2) ? 1 : Math.Min(failures + 1, 5);
        System.Windows.Forms.Timer wait = new System.Windows.Forms.Timer();
        wait.Interval = (int)Math.Min(60000, 5000 * Math.Pow(2, failures - 1));
        wait.Tick += delegate
        {
            wait.Dispose();
            if (!quitting && pendingUpdate == null && process == IntPtr.Zero) Start();
        };
        wait.Start();
    }

    private void Quit()
    {
        if (quitting) return;
        quitting = true;
        tray.Visible = false;
        if (process == IntPtr.Zero) ExitThread();
        else Stop();
    }

    private void ToggleStartup()
    {
        bool enabled = !NexaConnectorStartup.Enabled(self);
        NexaConnectorStartup.Set(self, enabled);
        startAtSignIn.Checked = enabled;
    }

    /// <summary>Looks for a newer signed version off the UI thread; an interactive check reports its result.</summary>
    private void Check(bool interactive)
    {
        if (Interlocked.Exchange(ref checking, 1) == 1) return;
        ThreadPool.QueueUserWorkItem(delegate
        {
            string downloaded = null;
            string message = null;
            try
            {
                downloaded = NexaConnectorSupervisorUpdates.Download(log);
                if (downloaded == null && interactive) message = "Nerva Connector is up to date.";
            }
            catch (Exception failure)
            {
                log.Write("update check failed: " + failure.Message);
                if (interactive) message = "Couldn't check for updates. Try again later.";
            }
            finally
            {
                Interlocked.Exchange(ref checking, 0);
            }
            ui.BeginInvoke(new Action(delegate
            {
                if (message != null) tray.ShowBalloonTip(5000, "Nerva Connector", message, ToolTipIcon.Info);
                if (downloaded != null) Update(downloaded);
            }));
        });
    }

    /// <summary>Stops the connector for a verified setup program; the install starts when it has stopped.</summary>
    private void Update(string setup)
    {
        if (quitting || pendingUpdate != null) return;
        log.Write("installing update " + Path.GetFileName(setup));
        pendingUpdate = setup;
        if (process == IntPtr.Zero) Install(setup);
        else Stop();
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
        Thread listener = new Thread(delegate()
        {
            while (signal.WaitOne())
            {
                ui.BeginInvoke(action);
            }
        });
        listener.IsBackground = true;
        listener.Start();
    }
}

/// <summary>Finds, downloads and verifies updates in %LOCALAPPDATA%\Nerva Connector\Updates.</summary>
internal static class NexaConnectorSupervisorUpdates
{
    /// <summary>Whether this build was given an update feed and release key.</summary>
    internal static bool Configured
    {
        get { return NexaConnectorUpdateSettings.FeedUrl.Length != 0 && NexaConnectorUpdateSettings.PublicKeyXml.Length != 0; }
    }

    /// <summary>Removes downloads left by an earlier update.</summary>
    internal static void Clean(string data)
    {
        try
        {
            string updates = Path.Combine(data, "Updates");
            if (Directory.Exists(updates)) Directory.Delete(updates, true);
        }
        catch (IOException)
        {
            /* A setup program still running from there is removed next time. */
        }
        catch (UnauthorizedAccessException)
        {
            /* As above. */
        }
    }

    /// <summary>Downloads and verifies a newer setup program, returning its path, or null when this version is current.</summary>
    internal static string Download(NexaConnectorSupervisorLog log)
    {
        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
        Uri feed = new Uri(NexaConnectorUpdateSettings.FeedUrl);
        byte[] latest = Fetch(new Uri(feed, "latest.json"), 65536);
        string signature = Encoding.ASCII.GetString(Fetch(new Uri(feed, "latest.json.sig"), 8192));
        NexaConnectorUpdate update = NexaConnectorUpdateFeed.Select(latest, signature, NexaConnectorUpdateSettings.PublicKeyXml, NexaConnectorUpdateSettings.Architecture, NexaConnectorUpdateSettings.Version);
        if (update == null) return null;
        log.Write("update " + update.Version + " found");
        string updates = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nerva Connector", "Updates");
        Directory.CreateDirectory(updates);
        string destination = Path.Combine(updates, update.Name);
        if (NexaConnectorUpdateFeed.Matches(destination, update)) return destination;
        string partial = destination + ".partial";
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(new Uri(feed, update.Name));
        request.Timeout = 600000;
        request.ReadWriteTimeout = 120000;
        using (WebResponse response = request.GetResponse())
        using (Stream input = response.GetResponseStream())
        using (FileStream output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            byte[] buffer = new byte[81920];
            long total = 0;
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                total += read;
                if (total > update.Size) throw new InvalidDataException("The update is larger than its signed size.");
                output.Write(buffer, 0, read);
            }
        }
        if (!NexaConnectorUpdateFeed.Matches(partial, update))
        {
            File.Delete(partial);
            throw new InvalidDataException("The downloaded update does not match its signed size and SHA-256.");
        }
        if (File.Exists(destination)) File.Delete(destination);
        File.Move(partial, destination);
        return destination;
    }

    private static byte[] Fetch(Uri address, int maximum)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(address);
        request.Timeout = 30000;
        request.ReadWriteTimeout = 30000;
        request.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
        using (WebResponse response = request.GetResponse())
        using (Stream input = response.GetResponseStream())
        using (MemoryStream output = new MemoryStream())
        {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (output.Length + read > maximum) throw new InvalidDataException("The update feed is too large.");
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }
    }
}

/// <summary>A small bounded log of starts, stops and updates in %LOCALAPPDATA%\Nerva Connector\Logs\supervisor.log.</summary>
internal sealed class NexaConnectorSupervisorLog
{
    private const long MaximumBytes = 262144;
    private readonly string path;
    private readonly object gate = new object();

    internal NexaConnectorSupervisorLog(string path)
    {
        this.path = path;
    }

    /// <summary>Appends one timestamped line; logging never stops the connector.</summary>
    internal void Write(string message)
    {
        lock (gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                FileInfo info = new FileInfo(path);
                if (info.Exists && info.Length > MaximumBytes)
                {
                    string previous = path + ".1";
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(path, previous);
                }
                File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " " + message.Replace('\r', ' ').Replace('\n', ' ') + "\r\n");
            }
            catch (IOException)
            {
                /* Logging is best effort. */
            }
            catch (UnauthorizedAccessException)
            {
                /* As above. */
            }
        }
    }
}

/// <summary>The Win32 calls the supervisor needs to run and control the connector's console window.</summary>
internal static class NexaConnectorSupervisorNative
{
    internal delegate bool ConsoleHandler(uint type);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation created);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AttachConsole(int processId);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool FreeConsole();

    [DllImport("kernel32.dll")]
    internal static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroup);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetConsoleCtrlHandler(ConsoleHandler handler, [MarshalAs(UnmanagedType.Bool)] bool add);

    [DllImport("kernel32.dll")]
    internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateProcess(IntPtr process, uint code);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetSystemMenu(IntPtr window, [MarshalAs(UnmanagedType.Bool)] bool revert);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DeleteMenu(IntPtr menu, uint position, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DrawMenuBar(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
