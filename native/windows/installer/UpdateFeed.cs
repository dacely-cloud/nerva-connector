// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

/// <summary>A newer setup program the update feed offers for this computer's architecture.</summary>
internal sealed class NexaConnectorUpdate
{
    internal string Version;
    internal string Name;
    internal long Size;
    internal string Sha256;
}

/// <summary>
/// Reads the signed update feed and decides whether a newer version exists for this computer.
/// </summary>
/// <remarks>
/// The feed is latest.json plus latest.json.sig, the base64 RSA PKCS#1 v1.5 SHA-256 signature of latest.json's exact
/// bytes, made with the release key whose public half is compiled into this program. Nothing in latest.json is trusted
/// before that signature verifies, so a changed file, a different server or a man in the middle cannot offer a setup
/// program. latest.json is {"product":"nerva-connector-windows","version":"1.2.3","files":{"x64":{"name":...,
/// "size":"<bytes>","sha256":"<hex>"},"arm64":{...}}}; script/ConnectorWindowsUpdateFeed.ts writes and signs it. Only a
/// strictly newer version is offered, so replaying an older signed feed cannot downgrade the connector.
/// </remarks>
internal static class NexaConnectorUpdateFeed
{
    internal const long MaximumSetupBytes = 268435456;
    private const int MaximumFeedBytes = 65536;

    /// <summary>The newer update for <paramref name="architecture"/>, or null when this version is current.</summary>
    /// <exception cref="InvalidDataException">The signature does not verify or the feed is malformed.</exception>
    internal static NexaConnectorUpdate Select(
        byte[] feed,
        string signature,
        string publicKeyXml,
        string architecture,
        string installed
    )
    {
        if (feed == null || feed.Length == 0 || feed.Length > MaximumFeedBytes)
        {
            throw Invalid();
        }
        byte[] signed;
        try
        {
            signed = Convert.FromBase64String(signature.Trim());
        }
        catch (FormatException)
        {
            throw Invalid();
        }
        using (RSACryptoServiceProvider key = new RSACryptoServiceProvider(new CspParameters(24)))
        {
            key.PersistKeyInCsp = false;
            key.FromXmlString(publicKeyXml);
            if (
                key.KeySize < 3072
                || !key.VerifyData(feed, CryptoConfig.MapNameToOID("SHA256"), signed)
            )
            {
                throw Invalid();
            }
        }
        Dictionary<string, object> root = Record(
            new JavaScriptSerializer().DeserializeObject(
                new UTF8Encoding(false, true).GetString(feed)
            ),
            new string[] { "product", "version", "files" }
        );
        if (Text(root, "product") != "nerva-connector-windows")
        {
            throw Invalid();
        }
        string version = Text(root, "version");
        if (Compare(version, installed) <= 0)
        {
            return null;
        }
        Dictionary<string, object> files = Record(root["files"], null);
        object entry;
        if (!files.TryGetValue(architecture, out entry))
        {
            return null;
        }
        Dictionary<string, object> file = Record(entry, new string[] { "name", "size", "sha256" });
        NexaConnectorUpdate update = new NexaConnectorUpdate();
        update.Version = version;
        update.Name = Text(file, "name");
        update.Sha256 = Text(file, "sha256");
        string size = Text(file, "size");
        if (
            !Regex.IsMatch(
                update.Name,
                @"\ANerva-Connector-Setup-[0-9]+\.[0-9]+\.[0-9]+-(x64|arm64)\.exe\z"
            )
            || !Regex.IsMatch(update.Sha256, @"\A[0-9a-f]{64}\z")
            || !Regex.IsMatch(size, @"\A[1-9][0-9]{0,9}\z")
            || !long.TryParse(size, out update.Size)
            || update.Size > MaximumSetupBytes
        )
        {
            throw Invalid();
        }
        return update;
    }

    /// <summary>Compares two major.minor.patch versions numerically.</summary>
    /// <exception cref="InvalidDataException">Either is not a plain three-part version.</exception>
    internal static int Compare(string left, string right)
    {
        int[] a = Parts(left);
        int[] b = Parts(right);
        for (int index = 0; index < 3; index++)
        {
            if (a[index] != b[index])
            {
                return a[index] < b[index] ? -1 : 1;
            }
        }
        return 0;
    }

    /// <summary>Whether a downloaded file has exactly the signed size and SHA-256.</summary>
    internal static bool Matches(string path, NexaConnectorUpdate update)
    {
        FileInfo info = new FileInfo(path);
        if (!info.Exists || info.Length != update.Size)
        {
            return false;
        }
        using (FileStream stream = info.OpenRead())
        using (SHA256 hash = SHA256.Create())
        {
            return BitConverter
                    .ToString(hash.ComputeHash(stream))
                    .Replace("-", "")
                    .ToLowerInvariant() == update.Sha256;
        }
    }

    private static int[] Parts(string version)
    {
        Match match = Regex.Match(version ?? "", @"\A([0-9]{1,5})\.([0-9]{1,5})\.([0-9]{1,5})\z");
        if (!match.Success)
        {
            throw Invalid();
        }
        return new int[]
        {
            int.Parse(match.Groups[1].Value),
            int.Parse(match.Groups[2].Value),
            int.Parse(match.Groups[3].Value),
        };
    }

    private static Dictionary<string, object> Record(object value, string[] fields)
    {
        Dictionary<string, object> record = value as Dictionary<string, object>;
        if (record == null)
        {
            throw Invalid();
        }
        if (fields != null)
        {
            if (record.Count != fields.Length)
            {
                throw Invalid();
            }
            foreach (string field in fields)
            {
                if (!record.ContainsKey(field))
                {
                    throw Invalid();
                }
            }
        }
        return record;
    }

    private static string Text(Dictionary<string, object> record, string field)
    {
        string text = record[field] as string;
        if (string.IsNullOrEmpty(text) || text.Length > 256)
        {
            throw Invalid();
        }
        return text;
    }

    private static InvalidDataException Invalid()
    {
        return new InvalidDataException("The update feed is not signed by Nerva or is malformed.");
    }
}
