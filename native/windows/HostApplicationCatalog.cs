// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using Microsoft.Win32;

/// <summary>One installed application retains the OS catalog identifier or its registered executable/shortcut.</summary>
internal sealed class NexaConnectorApplicationEntry
{
    internal string Name;
    internal string Id;
}

/// <summary>Windows discovery includes packaged apps, per-user/common Start menus, and both registry views of App Paths.</summary>
internal static class NexaConnectorHostApplicationCatalog
{
    private const int CatalogLimit = 8192;
    private const string WindowsCalculator = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";

    internal static List<NexaConnectorApplicationEntry> Find(string query)
    {
        List<NexaConnectorApplicationEntry> shell = Select(query, ShellApps());
        if (shell.Count != 0)
            return shell;
        List<NexaConnectorApplicationEntry> shortcuts = Select(query, Shortcuts());
        if (shortcuts.Count != 0)
            return shortcuts;
        List<NexaConnectorApplicationEntry> registered = Select(query, Registered());
        if (registered.Count != 0)
            return registered;
        return Select(query, Packages(query));
    }

    /// <summary>Resolve one supported browser directly from its per-user or machine App Paths registration.</summary>
    internal static List<NexaConnectorApplicationEntry> Browser(string query)
    {
        string name;
        string executable;
        switch (Compact(query).ToLowerInvariant())
        {
            case "chrome":
            case "googlechrome":
                name = "Google Chrome";
                executable = "chrome.exe";
                break;
            case "firefox":
            case "mozillafirefox":
                name = "Mozilla Firefox";
                executable = "firefox.exe";
                break;
            case "edge":
            case "microsoftedge":
                name = "Microsoft Edge";
                executable = "msedge.exe";
                break;
            default:
                throw new InvalidOperationException("application-browser-name");
        }
        foreach (
            RegistryHive hive in new RegistryHive[]
            {
                RegistryHive.CurrentUser,
                RegistryHive.LocalMachine,
            }
        )
        foreach (
            RegistryView view in new RegistryView[]
            {
                RegistryView.Registry64,
                RegistryView.Registry32,
            }
        )
        {
            try
            {
                using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                using (
                    RegistryKey entry = root.OpenSubKey(
                        @"Software\Microsoft\Windows\CurrentVersion\App Paths\" + executable
                    )
                )
                {
                    string path = entry == null ? null : entry.GetValue(null) as string;
                    if (String.IsNullOrWhiteSpace(path) || path.Length > 4096)
                    {
                        continue;
                    }
                    path = Environment.ExpandEnvironmentVariables(
                        path.Trim().Trim(new char[] { '"' })
                    );
                    if (
                        Path.IsPathRooted(path)
                        && String.Equals(
                            Path.GetFileName(path),
                            executable,
                            StringComparison.OrdinalIgnoreCase
                        )
                        && File.Exists(path)
                    )
                    {
                        return new List<NexaConnectorApplicationEntry>
                        {
                            new NexaConnectorApplicationEntry { Name = name, Id = path },
                        };
                    }
                }
            }
            catch (SecurityException) { }
            catch (UnauthorizedAccessException) { }
        }
        return new List<NexaConnectorApplicationEntry>();
    }

    /// <summary>Spacing and compatibility Unicode do not turn grandMA3 into a different application name.</summary>
    internal static string Compact(string value)
    {
        StringBuilder text = new StringBuilder();
        foreach (char character in value.Normalize(NormalizationForm.FormKC))
        {
            if (!Char.IsWhiteSpace(character))
                text.Append(character);
        }
        return text.ToString();
    }

    /// <summary>Exact matches win; a complete version family can resolve a short name.</summary>
    internal static List<NexaConnectorApplicationEntry> Select(
        string query,
        List<NexaConnectorApplicationEntry> catalog
    )
    {
        List<NexaConnectorApplicationEntry> exact = new List<NexaConnectorApplicationEntry>();
        List<NexaConnectorApplicationEntry> compact = new List<NexaConnectorApplicationEntry>();
        List<NexaConnectorApplicationEntry> partial = new List<NexaConnectorApplicationEntry>();
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string normalized = Compact(query);
        foreach (NexaConnectorApplicationEntry entry in catalog)
        {
            if (!seen.Add(entry.Id))
                continue;
            if (
                (
                    String.Equals(normalized, "calculator", StringComparison.OrdinalIgnoreCase)
                    || String.Equals(
                        normalized,
                        "windowscalculator",
                        StringComparison.OrdinalIgnoreCase
                    )
                    || String.Equals(normalized, "calculatrice", StringComparison.OrdinalIgnoreCase)
                ) && String.Equals(entry.Id, WindowsCalculator, StringComparison.OrdinalIgnoreCase)
            )
                return new List<NexaConnectorApplicationEntry> { entry };
            List<NexaConnectorApplicationEntry> matches = null;
            if (
                String.Equals(query, entry.Name, StringComparison.OrdinalIgnoreCase)
                || String.Equals(query, entry.Id, StringComparison.OrdinalIgnoreCase)
            )
                matches = exact;
            else
            {
                string name = Compact(entry.Name);
                string id = Compact(entry.Id);
                if (
                    String.Equals(normalized, name, StringComparison.OrdinalIgnoreCase)
                    || String.Equals(normalized, id, StringComparison.OrdinalIgnoreCase)
                )
                    matches = compact;
                else if (
                    name.IndexOf(normalized, StringComparison.OrdinalIgnoreCase) >= 0
                    || id.IndexOf(normalized, StringComparison.OrdinalIgnoreCase) >= 0
                )
                    matches = partial;
            }
            if (matches != null && (matches == partial || matches.Count < 32))
                matches.Add(entry);
        }
        if (exact.Count != 0)
            return exact;
        if (compact.Count != 0)
            return compact;

        List<NexaConnectorApplicationEntry> family =
            NexaConnectorHostApplicationVersionFamily.Choose(normalized, partial);
        return family ?? (partial.Count <= 32 ? partial : partial.GetRange(0, 32));
    }

    private static List<NexaConnectorApplicationEntry> ShellApps()
    {
        object shell = null;
        object folder = null;
        object items = null;
        List<NexaConnectorApplicationEntry> entries = new List<NexaConnectorApplicationEntry>();
        try
        {
            shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application", true));
            folder = Call(shell, "NameSpace", "shell:AppsFolder");
            if (folder == null)
                return entries;
            items = Call(folder, "Items");
            int count = Convert.ToInt32(Property(items, "Count"));
            if (count < 0 || count > CatalogLimit)
                throw new InvalidOperationException("application-catalog-limit");
            for (int index = 0; index < count; index++)
            {
                object item = null;
                try
                {
                    item = Call(items, "Item", index);
                    Add(
                        entries,
                        Convert.ToString(Property(item, "Name")),
                        Convert.ToString(Property(item, "Path"))
                    );
                }
                finally
                {
                    Release(item);
                }
            }
        }
        catch (COMException)
        {
            Console.Error.WriteLine("NERVA_DESKTOP catalog=apps-folder reason=unavailable");
        }
        finally
        {
            Release(items);
            Release(folder);
            Release(shell);
        }
        return entries;
    }

    private static List<NexaConnectorApplicationEntry> Shortcuts()
    {
        List<NexaConnectorApplicationEntry> entries = new List<NexaConnectorApplicationEntry>();
        HashSet<string> relative = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int scanned = 0;
        foreach (
            Environment.SpecialFolder kind in new Environment.SpecialFolder[]
            {
                Environment.SpecialFolder.Programs,
                Environment.SpecialFolder.CommonPrograms,
            }
        )
        {
            string root = Environment.GetFolderPath(kind);
            if (String.IsNullOrEmpty(root) || !Directory.Exists(root))
                continue;
            List<Tuple<string, int>> pending = new List<Tuple<string, int>>();
            pending.Add(Tuple.Create(root, 0));
            int head = 0;
            while (head < pending.Count)
            {
                Tuple<string, int> current = pending[head++];
                try
                {
                    foreach (string path in Directory.EnumerateFileSystemEntries(current.Item1))
                    {
                        if (++scanned > CatalogLimit)
                            throw new InvalidOperationException("application-catalog-limit");
                        FileAttributes attributes = File.GetAttributes(path);
                        if ((attributes & FileAttributes.ReparsePoint) != 0)
                            continue;
                        if ((attributes & FileAttributes.Directory) != 0)
                        {
                            if (current.Item2 < 8)
                                pending.Add(Tuple.Create(path, current.Item2 + 1));
                        }
                        else if (
                            String.Equals(
                                Path.GetExtension(path),
                                ".lnk",
                                StringComparison.OrdinalIgnoreCase
                            ) && relative.Add(path.Substring(root.Length))
                        )
                        {
                            Add(entries, Path.GetFileNameWithoutExtension(path), path);
                        }
                    }
                }
                catch (UnauthorizedAccessException)
                {
                    Console.Error.WriteLine(
                        "NERVA_DESKTOP catalog=start-menu reason=access-denied"
                    );
                }
                catch (DirectoryNotFoundException)
                {
                    Console.Error.WriteLine("NERVA_DESKTOP catalog=start-menu reason=changed");
                }
            }
        }
        return entries;
    }

    private static List<NexaConnectorApplicationEntry> Registered()
    {
        List<NexaConnectorApplicationEntry> entries = new List<NexaConnectorApplicationEntry>();
        HashSet<string> registered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int scanned = 0;
        foreach (
            RegistryHive hive in new RegistryHive[]
            {
                RegistryHive.CurrentUser,
                RegistryHive.LocalMachine,
            }
        )
        foreach (
            RegistryView view in new RegistryView[]
            {
                RegistryView.Registry64,
                RegistryView.Registry32,
            }
        )
        {
            try
            {
                using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                using (
                    RegistryKey paths = root.OpenSubKey(
                        @"Software\Microsoft\Windows\CurrentVersion\App Paths"
                    )
                )
                {
                    if (paths == null)
                        continue;
                    string[] names = paths.GetSubKeyNames();
                    if (names.Length + scanned > CatalogLimit)
                        throw new InvalidOperationException("application-catalog-limit");
                    scanned += names.Length;
                    foreach (string name in names)
                    {
                        using (RegistryKey entry = paths.OpenSubKey(name))
                        {
                            string path = entry == null ? null : entry.GetValue(null) as string;
                            if (String.IsNullOrWhiteSpace(path) || path.Length > 4096)
                                continue;
                            path = Environment.ExpandEnvironmentVariables(
                                path.Trim().Trim(new char[] { '"' })
                            );
                            if (
                                !Path.IsPathRooted(path)
                                || !String.Equals(
                                    Path.GetExtension(path),
                                    ".exe",
                                    StringComparison.OrdinalIgnoreCase
                                )
                                || !File.Exists(path)
                                || !registered.Add(name)
                            )
                                continue;
                            FileVersionInfo version = FileVersionInfo.GetVersionInfo(path);
                            string title = String.IsNullOrWhiteSpace(version.FileDescription)
                                ? Path.GetFileNameWithoutExtension(path)
                                : version.FileDescription;
                            Add(entries, title, path);
                        }
                    }
                }
            }
            catch (UnauthorizedAccessException)
            {
                Console.Error.WriteLine("NERVA_DESKTOP catalog=app-paths reason=access-denied");
            }
            catch (SecurityException)
            {
                Console.Error.WriteLine("NERVA_DESKTOP catalog=app-paths reason=access-denied");
            }
            catch (IOException)
            {
                Console.Error.WriteLine("NERVA_DESKTOP catalog=app-paths reason=changed");
            }
        }
        return entries;
    }

    private static void Add(List<NexaConnectorApplicationEntry> entries, string name, string id)
    {
        if (
            String.IsNullOrWhiteSpace(name)
            || String.IsNullOrWhiteSpace(id)
            || name.Length > 512
            || id.Length > 4096
        )
            return;
        if (
            name.IndexOfAny(new char[] { '\0', '\r', '\n' }) >= 0
            || id.IndexOfAny(new char[] { '\0', '\r', '\n' }) >= 0
        )
            return;
        entries.Add(new NexaConnectorApplicationEntry { Name = name, Id = id });
    }

    private static List<NexaConnectorApplicationEntry> Packages(string query)
    {
        List<NexaConnectorApplicationEntry> entries = new List<NexaConnectorApplicationEntry>();
        int scanned = 0;
        string normalized = Compact(query);
        foreach (
            RegistryHive hive in new RegistryHive[]
            {
                RegistryHive.CurrentUser,
                RegistryHive.LocalMachine,
            }
        )
        foreach (
            RegistryView view in new RegistryView[]
            {
                RegistryView.Registry64,
                RegistryView.Registry32,
            }
        )
        {
            try
            {
                using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                using (
                    RegistryKey packages = root.OpenSubKey(
                        @"Software\Microsoft\Windows\CurrentVersion\Uninstall"
                    )
                )
                {
                    if (packages == null)
                        continue;
                    string[] names = packages.GetSubKeyNames();
                    if (names.Length + scanned > CatalogLimit)
                        throw new InvalidOperationException("application-catalog-limit");
                    scanned += names.Length;
                    foreach (string name in names)
                        using (RegistryKey package = packages.OpenSubKey(name))
                        {
                            if (package == null)
                                continue;
                            string title = package.GetValue("DisplayName") as string;
                            string icon = package.GetValue("DisplayIcon") as string;
                            if (
                                String.IsNullOrWhiteSpace(title)
                                || title.Length > 512
                                || String.IsNullOrWhiteSpace(icon)
                                || icon.Length > 4096
                            )
                                continue;
                            string path = IconExecutable(icon);
                            if (
                                path == null
                                || (
                                    Compact(title)
                                        .IndexOf(normalized, StringComparison.OrdinalIgnoreCase) < 0
                                    && !String.Equals(
                                        query,
                                        path,
                                        StringComparison.OrdinalIgnoreCase
                                    )
                                )
                            )
                                continue;
                            Add(entries, title, path);
                        }
                }
            }
            catch (UnauthorizedAccessException)
            {
                Console.Error.WriteLine(
                    "NERVA_DESKTOP catalog=installed-packages reason=access-denied"
                );
            }
            catch (SecurityException)
            {
                Console.Error.WriteLine(
                    "NERVA_DESKTOP catalog=installed-packages reason=access-denied"
                );
            }
            catch (IOException)
            {
                Console.Error.WriteLine("NERVA_DESKTOP catalog=installed-packages reason=changed");
            }
        }
        return entries;
    }

    /// <summary>Only a registered executable icon can supply a package fallback; uninstall commands and arbitrary directory guesses never launch.</summary>
    internal static string IconExecutable(string value)
    {
        string path = Environment.ExpandEnvironmentVariables(value.Trim());
        if (path.StartsWith("\"", StringComparison.Ordinal))
        {
            int end = path.IndexOf('"', 1);
            if (end < 0)
                return null;
            path = path.Substring(1, end - 1);
        }
        else
        {
            int comma = path.LastIndexOf(',');
            int index;
            if (comma >= 0 && Int32.TryParse(path.Substring(comma + 1).Trim(), out index))
                path = path.Substring(0, comma).Trim();
        }
        string name = Path.GetFileNameWithoutExtension(path);
        if (
            !Path.IsPathRooted(path)
            || !String.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(path)
            || name.IndexOf("uninstall", StringComparison.OrdinalIgnoreCase) >= 0
            || name.IndexOf("setup", StringComparison.OrdinalIgnoreCase) >= 0
        )
            return null;
        return path;
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
            Marshal.FinalReleaseComObject(instance);
    }
}
