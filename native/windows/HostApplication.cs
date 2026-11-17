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
    internal static Dictionary<string, object> Open(string name)
    {
        if (
            String.IsNullOrWhiteSpace(name)
            || name.Length > 4096
            || name.IndexOfAny(new char[] { '\0', '\r', '\n' }) >= 0
        )
        {
            throw new InvalidOperationException("application-name");
        }
        List<NexaConnectorApplicationEntry> matches = NexaConnectorHostApplicationCatalog.Find(
            name.Trim()
        );
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
        IntPtr accepted = ShellExecuteW(
            IntPtr.Zero,
            "open",
            Path.IsPathRooted(selected.Id)
            || selected.Id.StartsWith("shell:", StringComparison.OrdinalIgnoreCase)
                ? selected.Id
                : "shell:AppsFolder\\" + selected.Id,
            null,
            null,
            1
        );
        if (accepted.ToInt64() <= 32)
        {
            throw new InvalidOperationException("application-launch-rejected");
        }
        Stopwatch elapsed = Stopwatch.StartNew();
        do
        {
            if (ActivateWindow(selected.Name))
            {
                result["windowObserved"] = true;
                Thread.Sleep(100);
                break;
            }
            Thread.Sleep(50);
        } while (elapsed.ElapsedMilliseconds < 2500);
        result["elapsedMs"] = elapsed.ElapsedMilliseconds;
        return result;
    }

    /// <summary>Window titles are observed evidence, not an assertion that a launched process is ready.</summary>
    private static bool ActivateWindow(string name)
    {
        bool found = false;
        EnumWindows(
            delegate(IntPtr window, IntPtr ignored)
            {
                if (!IsWindowVisible(window))
                {
                    return true;
                }
                int cloaked;
                if (
                    DwmGetWindowAttribute(window, 14, out cloaked, sizeof(int)) != 0
                    || cloaked != 0
                )
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
                found = true;
                return false;
            },
            IntPtr.Zero
        );
        return found;
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
