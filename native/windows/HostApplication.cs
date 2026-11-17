// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
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
        List<Application> matches = Find(name.Trim());
        List<Dictionary<string, object>> candidates = new List<Dictionary<string, object>>();
        foreach (Application application in matches)
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
        Application selected = matches[0];
        IntPtr accepted = ShellExecuteW(
            IntPtr.Zero,
            "open",
            "shell:AppsFolder\\" + selected.Id,
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

    /// <summary>Exact display names or identifiers win; partial names must resolve to exactly one installed entry.</summary>
    private static List<Application> Find(string query)
    {
        Type shellType = Type.GetTypeFromProgID("Shell.Application", true);
        object shell = null;
        object folder = null;
        object items = null;
        List<Application> exact = new List<Application>();
        List<Application> partial = new List<Application>();
        try
        {
            shell = Activator.CreateInstance(shellType);
            folder = Call(shell, "NameSpace", "shell:AppsFolder");
            if (folder == null)
            {
                throw new InvalidOperationException("application-catalog-unavailable");
            }
            items = Call(folder, "Items");
            int count = Convert.ToInt32(Property(items, "Count"));
            if (count < 0 || count > 8192)
            {
                throw new InvalidOperationException("application-catalog-limit");
            }
            for (int index = 0; index < count; index++)
            {
                object item = null;
                try
                {
                    item = Call(items, "Item", index);
                    string name = Convert.ToString(Property(item, "Name"));
                    string id = Convert.ToString(Property(item, "Path"));
                    if (
                        String.IsNullOrWhiteSpace(name)
                        || String.IsNullOrWhiteSpace(id)
                        || name.Length > 512
                        || id.Length > 4096
                    )
                    {
                        continue;
                    }
                    Application application = new Application { Name = name, Id = id };
                    if (
                        String.Equals(query, name, StringComparison.OrdinalIgnoreCase)
                        || String.Equals(query, id, StringComparison.OrdinalIgnoreCase)
                    )
                    {
                        exact.Add(application);
                    }
                    else if (
                        partial.Count < 32
                        && (
                            name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0
                            || id.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0
                        )
                    )
                    {
                        partial.Add(application);
                    }
                    if (exact.Count > 32)
                    {
                        throw new InvalidOperationException("application-match-limit");
                    }
                }
                finally
                {
                    Release(item);
                }
            }
            return exact.Count > 0 ? exact : partial;
        }
        finally
        {
            Release(items);
            Release(folder);
            Release(shell);
        }
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
                if (!String.Equals(title.ToString(), name, StringComparison.OrdinalIgnoreCase))
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

    private static object Call(object instance, string name, params object[] arguments)
    {
        return instance
            .GetType()
            .InvokeMember(name, BindingFlags.InvokeMethod, null, instance, arguments);
    }

    private static object Property(object instance, string name)
    {
        return instance
            .GetType()
            .InvokeMember(name, BindingFlags.GetProperty, null, instance, null);
    }

    private static void Release(object instance)
    {
        if (instance != null && Marshal.IsComObject(instance))
        {
            Marshal.FinalReleaseComObject(instance);
        }
    }

    private sealed class Application
    {
        internal string Name;
        internal string Id;
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
