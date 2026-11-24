// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/// <summary>Resolve only installed Start menu applications and delegate one launch to the user's shell.</summary>
internal static class NexaConnectorHostApplication
{
    internal static Dictionary<string, object> Open(
        string name,
        string url = null,
        string workspaceFile = null
    )
    {
        if (
            String.IsNullOrWhiteSpace(name)
            || name.Length > 4096
            || name.IndexOfAny(new char[] { '\0', '\r', '\n' }) >= 0
        )
        {
            throw new InvalidOperationException("application-name");
        }
        string address =
            workspaceFile == null
                ? (url == null ? null : BrowserAddress(url))
                : WorkspaceDocumentAddress(workspaceFile);
        List<NexaConnectorApplicationEntry> matches =
            address == null
                ? NexaConnectorHostApplicationCatalog.Find(name.Trim())
                : NexaConnectorHostApplicationCatalog.Browser(name.Trim());
        List<Dictionary<string, object>> candidates = new List<Dictionary<string, object>>();
        foreach (NexaConnectorApplicationEntry application in matches)
        {
            candidates.Add(
                new Dictionary<string, object>
                {
                    { "name", application.Name },
                    { "id", application.Id },
                }
            );
        }
        Dictionary<string, object> result = new Dictionary<string, object>
        {
            {
                "status",
                matches.Count == 0 ? "not-found"
                : matches.Count == 1 ? "launched"
                : "ambiguous"
            },
            { "candidates", candidates },
            { "windowObserved", false },
        };
        if (matches.Count != 1)
        {
            return result;
        }
        NexaConnectorApplicationEntry selected = matches[0];
        bool packaged =
            address == null
            && !Path.IsPathRooted(selected.Id)
            && NexaConnectorPackagedApplication.IsPackagedId(selected.Id);
        if (packaged)
        {
            NexaConnectorPackagedApplication.Launch(selected.Id);
        }
        else if (
            ShellExecuteW(
                    IntPtr.Zero,
                    "open",
                    Path.IsPathRooted(selected.Id)
                    || selected.Id.StartsWith("shell:", StringComparison.OrdinalIgnoreCase)
                        ? selected.Id
                        : "shell:AppsFolder\\" + selected.Id,
                    address == null ? null : "\"" + address + "\"",
                    workspaceFile == null ? null : Path.GetDirectoryName(selected.Id),
                    1
                )
                .ToInt64() <= 32
        )
        {
            throw new InvalidOperationException("application-launch-rejected");
        }
        Stopwatch elapsed = Stopwatch.StartNew();
        // A cold browser must get time to present the workspace document within the desktop command deadline.
        int observationMs = workspaceFile == null && !packaged ? 2500 : 6000;
        do
        {
            IntPtr window =
                packaged ? NexaConnectorPackagedApplication.FindWindow(selected.Id)
                : address == null ? ActivateWindow(selected.Name)
                : BrowserWindow(selected.Id);
            if (packaged && window != IntPtr.Zero)
            {
                ShowWindow(window, 9);
                SetForegroundWindow(window);
                if (GetForegroundWindow() != window)
                    window = IntPtr.Zero;
            }
            if (window != IntPtr.Zero)
            {
                result["windowObserved"] = true;
                if (
                    Path.IsPathRooted(selected.Id)
                    && String.Equals(
                        NexaConnectorHostDesktopWindow.ExecutablePath(window),
                        selected.Id,
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                {
                    string target = NexaConnectorHostDesktopWindow.Observe(window);
                    if (target != null)
                    {
                        result["windowTarget"] = target;
                    }
                }
                Thread.Sleep(100);
                break;
            }
            Thread.Sleep(50);
        } while (elapsed.ElapsedMilliseconds < observationMs);
        result["elapsedMs"] = elapsed.ElapsedMilliseconds;
        return result;
    }

    /// <summary>The workspace layer supplies a resolved regular document. The desktop helper accepts only an ordinary local drive path.</summary>
    private static string WorkspaceDocumentAddress(string path)
    {
        if (
            path.Length < 4
            || path.Length > 4096
            || !((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z'))
            || path[1] != ':'
            || path[2] != '\\'
            || path.IndexOfAny(new char[] { '\0', '\r', '\n', '"', '/' }) >= 0
            || path.IndexOf(':', 2) >= 0
            || !(
                path.EndsWith(".html", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith(".htm", StringComparison.OrdinalIgnoreCase)
            )
        )
        {
            throw new InvalidOperationException("application-browser-url");
        }
        string escaped = String.Join(
            "/",
            Array.ConvertAll(path.Substring(3).Split(new char[] { '\\' }), Uri.EscapeDataString)
        );
        string address = "file:///" + path.Substring(0, 2) + "/" + escaped;
        if (address.Length > 4096)
        {
            throw new InvalidOperationException("application-browser-url");
        }
        return address;
    }

    /// <summary>One web address becomes one literal browser argument; local files, arguments and custom schemes cannot cross.</summary>
    private static string BrowserAddress(string value)
    {
        Uri uri;
        if (
            value.Length > 4096
            || value.IndexOfAny(new char[] { '\0', '\r', '\n', '"', '\\' }) >= 0
            || !Uri.TryCreate(value, UriKind.Absolute, out uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            || uri.Host.Length == 0
            || uri.UserInfo.Length != 0
            || uri.AbsoluteUri.IndexOfAny(new char[] { '"', '\\' }) >= 0
        )
        {
            throw new InvalidOperationException("application-browser-url");
        }
        return uri.AbsoluteUri;
    }

    /// <summary>For a browser launch, verify its actual registered executable without changing keyboard focus.</summary>
    private static IntPtr BrowserWindow(string executable)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(
            delegate(IntPtr window, IntPtr ignored)
            {
                if (!Visible(window))
                {
                    return true;
                }
                if (
                    String.Equals(
                        NexaConnectorHostDesktopWindow.ExecutablePath(window),
                        executable,
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                {
                    found = window;
                    return false;
                }
                return true;
            },
            IntPtr.Zero
        );
        return found;
    }

    /// <summary>Window titles are observed evidence, not an assertion that a launched process is ready.</summary>
    private static IntPtr ActivateWindow(string name)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(
            delegate(IntPtr window, IntPtr ignored)
            {
                if (!Visible(window))
                {
                    return true;
                }
                StringBuilder title = new StringBuilder(1024);
                GetWindowTextW(window, title, title.Capacity);
                if (
                    NexaConnectorHostApplicationCatalog
                        .Compact(title.ToString())
                        .IndexOf(
                            NexaConnectorHostApplicationCatalog.Compact(name),
                            StringComparison.OrdinalIgnoreCase
                        ) < 0
                )
                {
                    return true;
                }
                ShowWindow(window, 9);
                SetForegroundWindow(window);
                if (GetForegroundWindow() != window)
                {
                    return true;
                }
                found = window;
                return false;
            },
            IntPtr.Zero
        );
        return found;
    }

    internal static bool Visible(IntPtr window)
    {
        int cloaked;
        return IsWindowVisible(window)
            && DwmGetWindowAttribute(window, 14, out cloaked, sizeof(int)) == 0
            && cloaked == 0;
    }

    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr ShellExecuteW(
        IntPtr window,
        string verb,
        string file,
        string parameters,
        string directory,
        int show
    );

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(
        IntPtr window,
        int attribute,
        out int value,
        int size
    );

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr window, StringBuilder text, int maximum);
}
