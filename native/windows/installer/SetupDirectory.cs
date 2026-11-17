// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.IO;

/// <summary>Owns one private staging directory and publishes only a verified complete installation.</summary>
internal sealed class NexaConnectorSetupDirectory : IDisposable
{
    internal const string OwnershipFile = ".nerva-connector-installation";
    private const string Ownership = "nerva-connector-installation-v1\n";
    private readonly string target;
    private readonly string previous;
    private readonly bool registered;
    private readonly List<string> createdParents = new List<string>();
    private bool published;
    private bool disposed;
    internal readonly string Staging;

    internal NexaConnectorSetupDirectory(string directory, bool registeredInstallation)
    {
        target = directory;
        registered = registeredInstallation;
        CheckAncestors(target);
        CheckDestinationOwnership();
        string suffix = Guid.NewGuid().ToString("N").Substring(0, 12);
        Staging = target + ".new-" + suffix;
        previous = target + ".old-" + suffix;
        if (Directory.Exists(Staging) || Directory.Exists(previous))
        {
            throw new IOException("The setup working directory already exists. Try again.");
        }
        TrackMissingParents();
        try
        {
            Directory.CreateDirectory(Staging);
        }
        catch
        {
            RemoveEmptyParents();
            throw;
        }
    }

    /// <summary>Requires a local absolute Windows path and rejects drive roots, aliases and unsafe leaf names.</summary>
    internal static string ValidateChoice(string directory)
    {
        if (
            directory == null
            || directory.Length < 4
            || directory.Length > 200
            || !Char.IsLetter(directory[0])
            || directory[0] > 127
            || directory[1] != ':'
            || directory[2] != '\\'
        )
        {
            throw new ArgumentException(
                "Choose an absolute local installation folder, such as D:\\Apps\\Nerva Connector (up to 200 characters)."
            );
        }
        foreach (string name in directory.Substring(3).Split(new char[] { '\\' }))
        {
            if (
                name.Length == 0
                || name == "."
                || name == ".."
                || name.EndsWith(" ", StringComparison.Ordinal)
                || name.EndsWith(".", StringComparison.Ordinal)
            )
            {
                throw new ArgumentException("The installation folder contains an invalid name.");
            }
            foreach (char character in name)
            {
                if (character < 32 || "<>:\"/|?*".IndexOf(character) >= 0)
                {
                    throw new ArgumentException(
                        "The installation folder contains an invalid character."
                    );
                }
            }
            if (ReservedDeviceName(name))
            {
                throw new ArgumentException(
                    "The installation folder contains a reserved Windows name."
                );
            }
        }
        return directory;
    }

    private static bool ReservedDeviceName(string name)
    {
        int extension = name.IndexOf('.');
        string stem = (extension < 0 ? name : name.Substring(0, extension)).TrimEnd(
            new char[] { ' ' }
        );
        if (
            String.Equals(stem, "CON", StringComparison.OrdinalIgnoreCase)
            || String.Equals(stem, "PRN", StringComparison.OrdinalIgnoreCase)
            || String.Equals(stem, "AUX", StringComparison.OrdinalIgnoreCase)
            || String.Equals(stem, "NUL", StringComparison.OrdinalIgnoreCase)
        )
        {
            return true;
        }
        if (
            stem.Length != 4
            || (
                !stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase)
                && !stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)
            )
        )
        {
            return false;
        }
        char suffix = stem[3];
        return (suffix >= '0' && suffix <= '9') || suffix == '¹' || suffix == '²' || suffix == '³';
    }

    /// <summary>Refuses links and unrelated files before publishing a complete installation.</summary>
    internal void Publish(IEnumerable<NexaConnectorPayloadFile> files)
    {
        if (published || disposed)
        {
            throw new InvalidOperationException("The staged installation has already finished.");
        }
        HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (NexaConnectorPayloadFile file in files)
        {
            names.Add(file.Name);
        }
        if (!names.Add(OwnershipFile))
        {
            throw new IOException("The setup payload contains a reserved installation file.");
        }
        File.WriteAllText(Path.Combine(Staging, OwnershipFile), Ownership);
        CheckAncestors(target);
        CheckDestinationOwnership();
        if (Directory.Exists(target))
        {
            foreach (string entry in Directory.EnumerateFileSystemEntries(target))
            {
                if (
                    !names.Remove(Path.GetFileName(entry))
                    || (
                        File.GetAttributes(entry)
                        & (FileAttributes.Directory | FileAttributes.ReparsePoint)
                    ) != 0
                )
                {
                    throw new IOException(
                        "The installation folder contains other files or links. Choose an empty folder to keep them safe."
                    );
                }
            }
            Directory.Move(target, previous);
        }
        try
        {
            Directory.Move(Staging, target);
            published = true;
        }
        catch
        {
            if (Directory.Exists(previous) && !Directory.Exists(target))
            {
                Directory.Move(previous, target);
            }
            throw;
        }
        if (Directory.Exists(previous))
        {
            Directory.Delete(previous, true);
        }
    }

    /// <summary>Rejects an unrelated destination before allocating or writing staging files.</summary>
    private void CheckDestinationOwnership()
    {
        FileAttributes attributes;
        if (!TryAttributes(target, out attributes))
        {
            return;
        }
        if ((attributes & FileAttributes.Directory) == 0)
        {
            throw new IOException("Choose an installation folder, not an existing file.");
        }
        if (!registered)
        {
            using (
                IEnumerator<string> entries = Directory
                    .EnumerateFileSystemEntries(target)
                    .GetEnumerator()
            )
            {
                if (entries.MoveNext() && !HasOwnership())
                {
                    throw new IOException(
                        "Choose an empty installation folder. Setup will not replace unrelated files."
                    );
                }
            }
        }
    }

    /// <summary>A completed directory publication can be retried if shortcut or registry registration failed.</summary>
    private bool HasOwnership()
    {
        string marker = Path.Combine(target, OwnershipFile);
        if (!File.Exists(marker) || (File.GetAttributes(marker) & FileAttributes.ReparsePoint) != 0)
        {
            return false;
        }
        using (
            FileStream input = new FileStream(
                marker,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read
            )
        )
        {
            if (input.Length != Ownership.Length)
            {
                return false;
            }
            for (int index = 0; index < Ownership.Length; index++)
            {
                if (input.ReadByte() != Ownership[index])
                {
                    return false;
                }
            }
            return input.ReadByte() == -1;
        }
    }

    private static void CheckAncestors(string directory)
    {
        for (
            DirectoryInfo current = new DirectoryInfo(directory);
            current != null;
            current = current.Parent
        )
        {
            FileAttributes attributes;
            if (
                TryAttributes(current.FullName, out attributes)
                && (attributes & FileAttributes.ReparsePoint) != 0
            )
            {
                throw new IOException(
                    "Choose an installation folder without directory links or junctions."
                );
            }
        }
    }

    private static bool TryAttributes(string path, out FileAttributes attributes)
    {
        try
        {
            attributes = File.GetAttributes(path);
            return true;
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        attributes = 0;
        return false;
    }

    private void TrackMissingParents()
    {
        for (
            DirectoryInfo parent = Directory.GetParent(Staging);
            parent != null;
            parent = parent.Parent
        )
        {
            FileAttributes attributes;
            if (TryAttributes(parent.FullName, out attributes))
            {
                break;
            }
            createdParents.Add(parent.FullName);
        }
    }

    private void RemoveEmptyParents()
    {
        foreach (string parent in createdParents)
        {
            FileAttributes attributes;
            if (!TryAttributes(parent, out attributes))
            {
                continue;
            }
            if (
                (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint))
                != FileAttributes.Directory
            )
            {
                break;
            }
            using (
                IEnumerator<string> entries = Directory
                    .EnumerateFileSystemEntries(parent)
                    .GetEnumerator()
            )
            {
                if (entries.MoveNext())
                {
                    break;
                }
            }
            Directory.Delete(parent);
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }
        if (Directory.Exists(Staging))
        {
            Directory.Delete(Staging, true);
        }
        if (published && Directory.Exists(previous))
        {
            Directory.Delete(previous, true);
        }
        if (!published)
        {
            RemoveEmptyParents();
        }
        disposed = true;
    }
}
