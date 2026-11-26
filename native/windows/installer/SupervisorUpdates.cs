// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Text;

/// <summary>Finds, downloads and verifies updates in %LOCALAPPDATA%\Nerva Connector\Updates.</summary>
internal static class NexaConnectorSupervisorUpdates
{
    /// <summary>Whether this build was given an update feed and release key.</summary>
    internal static bool Configured
    {
        get
        {
            return NexaConnectorUpdateSettings.FeedUrl.Length != 0
                && NexaConnectorUpdateSettings.PublicKeyXml.Length != 0;
        }
    }

    /// <summary>Removes downloads left by an earlier update.</summary>
    internal static void Clean(string data)
    {
        try
        {
            string updates = Path.Combine(data, "Updates");
            if (Directory.Exists(updates))
            {
                Directory.Delete(updates, true);
            }
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

    /// <summary>Downloads and verifies a newer setup program; native signature checks retain installation authority.</summary>
    internal static string Download(string directory, NexaConnectorSupervisorLog log)
    {
        Uri feed = new Uri(NexaConnectorUpdateSettings.FeedUrl);
        string updates = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Nerva Connector",
            "Updates"
        );
        Directory.CreateDirectory(updates);
        string check = Path.Combine(updates, "check-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(check);
        try
        {
            byte[] latest = Fetch(
                directory,
                new Uri(feed, "latest.json"),
                Path.Combine(check, "latest.json"),
                65536,
                "manifest",
                log
            );
            string signature = Encoding.ASCII.GetString(
                Fetch(
                    directory,
                    new Uri(feed, "latest.json.sig"),
                    Path.Combine(check, "latest.json.sig"),
                    8192,
                    "signature",
                    log
                )
            );
            NexaConnectorUpdate update = NexaConnectorUpdateFeed.Select(
                latest,
                signature,
                NexaConnectorUpdateSettings.PublicKeyXml,
                NexaConnectorUpdateSettings.Architecture,
                NexaConnectorUpdateSettings.Version
            );
            if (update == null)
                return null;
            log.Write("update " + update.Version + " found");
            string destination = Path.Combine(updates, update.Name);
            if (NexaConnectorUpdateFeed.Matches(destination, update))
                return destination;
            string partial = Path.Combine(check, update.Name + ".partial");
            try
            {
                NexaConnectorSupervisorUpdateTransport.Fetch(
                    directory,
                    new Uri(feed, update.Name),
                    partial,
                    update.Size,
                    600000,
                    "installer",
                    log
                );
                if (!NexaConnectorUpdateFeed.Matches(partial, update))
                    throw new InvalidDataException(
                        "update verify stage=installer code=SIZE_OR_HASH_MISMATCH"
                    );
                if (File.Exists(destination))
                    File.Delete(destination);
                File.Move(partial, destination);
                return destination;
            }
            finally
            {
                if (File.Exists(partial))
                    File.Delete(partial);
            }
        }
        finally
        {
            Directory.Delete(check, true);
        }
    }

    /// <summary>Metadata is bounded by Node before writing and checked again before native verification reads it.</summary>
    private static byte[] Fetch(
        string directory,
        Uri address,
        string destination,
        int maximum,
        string stage,
        NexaConnectorSupervisorLog log
    )
    {
        NexaConnectorSupervisorUpdateTransport.Fetch(
            directory,
            address,
            destination,
            maximum,
            20000,
            stage,
            log
        );
        FileInfo info = new FileInfo(destination);
        if (!info.Exists || info.Length > maximum)
            throw new InvalidDataException("update fetch stage=" + stage + " code=BODY_LIMIT");
        return File.ReadAllBytes(destination);
    }
}
