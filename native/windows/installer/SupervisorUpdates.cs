// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Net;
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

    /// <summary>Downloads and verifies a newer setup program, returning its path, or null when this version is current.</summary>
    internal static string Download(NexaConnectorSupervisorLog log)
    {
        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
        Uri feed = new Uri(NexaConnectorUpdateSettings.FeedUrl);
        byte[] latest = Fetch(new Uri(feed, "latest.json"), 65536);
        string signature = Encoding.ASCII.GetString(Fetch(new Uri(feed, "latest.json.sig"), 8192));
        NexaConnectorUpdate update = NexaConnectorUpdateFeed.Select(
            latest,
            signature,
            NexaConnectorUpdateSettings.PublicKeyXml,
            NexaConnectorUpdateSettings.Architecture,
            NexaConnectorUpdateSettings.Version
        );
        if (update == null)
        {
            return null;
        }
        log.Write("update " + update.Version + " found");
        string updates = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Nerva Connector",
            "Updates"
        );
        Directory.CreateDirectory(updates);
        string destination = Path.Combine(updates, update.Name);
        if (NexaConnectorUpdateFeed.Matches(destination, update))
        {
            return destination;
        }
        string partial = destination + ".partial";
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(new Uri(feed, update.Name));
        request.Timeout = 600000;
        request.ReadWriteTimeout = 120000;
        using (WebResponse response = request.GetResponse())
        using (Stream input = response.GetResponseStream())
        using (
            FileStream output = new FileStream(
                partial,
                FileMode.Create,
                FileAccess.Write,
                FileShare.None
            )
        )
        {
            byte[] buffer = new byte[81920];
            long total = 0;
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                total += read;
                if (total > update.Size)
                {
                    throw new InvalidDataException("The update is larger than its signed size.");
                }
                output.Write(buffer, 0, read);
            }
        }
        if (!NexaConnectorUpdateFeed.Matches(partial, update))
        {
            File.Delete(partial);
            throw new InvalidDataException(
                "The downloaded update does not match its signed size and SHA-256."
            );
        }
        if (File.Exists(destination))
        {
            File.Delete(destination);
        }
        File.Move(partial, destination);
        return destination;
    }

    private static byte[] Fetch(Uri address, int maximum)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(address);
        request.Timeout = 30000;
        request.ReadWriteTimeout = 30000;
        request.CachePolicy = new System.Net.Cache.RequestCachePolicy(
            System.Net.Cache.RequestCacheLevel.NoCacheNoStore
        );
        using (WebResponse response = request.GetResponse())
        using (Stream input = response.GetResponseStream())
        using (MemoryStream output = new MemoryStream())
        {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (output.Length + read > maximum)
                {
                    throw new InvalidDataException("The update feed is too large.");
                }
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }
    }
}
