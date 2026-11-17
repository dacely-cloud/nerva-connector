// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

/// <summary>The bootstrap accepts only a complete current manifest and an explicit bounded configuration.</summary>
public static partial class NexaConnectorStateOwner
{
    internal sealed class BootstrapArtifact
    {
        internal string Name;
        internal string Hash;
        internal long Size;
        internal int Maximum;
    }

    internal sealed class BootstrapConfig
    {
        internal string Architecture;
        internal string PublicKey;
        internal string BaseUrl;
        internal string Manifest;
        internal string Command;
        internal string Destination;
        internal string Offline;
        internal string Control;
        internal CancellationToken Cancellation;
        internal long Issued;
        internal long Expires;
        internal readonly List<BootstrapArtifact> Artifacts = new List<BootstrapArtifact>();
    }

    internal static BootstrapConfig ValidateBootstrapConfig(string line)
    {
        if (line == null || line.Length > 262144)
        {
            throw new Failure("limit");
        }
        Dictionary<string, object> config = BootstrapRecord(
            new BootstrapJson(line).Read(),
            new string[]
            {
                "protocol",
                "architecture",
                "manifestBase64",
                "releasePublicKey",
                "baseUrl",
                "argumentsJson",
                "control",
            }
        );
        if (BootstrapText(config, "protocol") != "nerva-connector-windows-bootstrap-v1")
        {
            throw new Failure("invalid");
        }
        BootstrapConfig result = new BootstrapConfig();
        result.Control = BootstrapText(config, "control");
        if (result.Control != "none" && result.Control != "stdin-v1")
        {
            throw new Failure("invalid");
        }
        result.Architecture = BootstrapText(config, "architecture");
        if (result.Architecture != "x64" && result.Architecture != "arm64")
        {
            throw new Failure("invalid");
        }
        result.PublicKey = BootstrapText(config, "releasePublicKey");
        if (!Regex.IsMatch(result.PublicKey, @"\A[A-Za-z0-9_-]{1792}\z"))
        {
            throw new Failure("invalid");
        }
        result.BaseUrl = BootstrapText(config, "baseUrl");
        Uri origin;
        if (
            !Uri.TryCreate(result.BaseUrl, UriKind.Absolute, out origin)
            || origin.Scheme != "https"
            || origin.UserInfo.Length != 0
            || origin.Query.Length != 0
            || origin.Fragment.Length != 0
            || result.BaseUrl.Length > 2048
            || !result.BaseUrl.EndsWith("/", StringComparison.Ordinal)
        )
        {
            throw new Failure("invalid");
        }
        string encoded = BootstrapText(config, "manifestBase64");
        byte[] bytes = Decode(encoded, 131072);
        result.Manifest = new UTF8Encoding(false, true).GetString(bytes);
        Dictionary<string, object> envelope = BootstrapRecord(
            new BootstrapJson(result.Manifest).Read(),
            new string[] { "manifest", "signature" }
        );
        string signature = BootstrapText(envelope, "signature");
        if (signature.Length != 3312 || !Regex.IsMatch(signature, @"\A[A-Za-z0-9_-]+\z"))
        {
            throw new Failure("invalid");
        }
        Dictionary<string, object> manifest = BootstrapRecord(
            envelope["manifest"],
            new string[]
            {
                "protocol",
                "releaseId",
                "revision",
                "issuedAtMs",
                "expiresAtMs",
                "platform",
                "architecture",
                "artifacts",
                "deployment",
            }
        );
        if (
            BootstrapText(manifest, "protocol") != "nerva-connector-release"
            || BootstrapText(manifest, "platform") != "win32"
            || BootstrapText(manifest, "architecture") != result.Architecture
        )
        {
            throw new Failure("invalid");
        }
        string releaseId = BootstrapText(manifest, "releaseId");
        if (!Regex.IsMatch(releaseId, @"\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\z"))
        {
            throw new Failure("invalid");
        }
        if (BootstrapInteger(BootstrapText(manifest, "revision")) < 1)
        {
            throw new Failure("invalid");
        }
        result.Issued = BootstrapInteger(BootstrapText(manifest, "issuedAtMs"));
        result.Expires = BootstrapInteger(BootstrapText(manifest, "expiresAtMs"));
        if (result.Expires <= result.Issued || result.Expires - result.Issued > 7776000000L)
        {
            throw new Failure("invalid");
        }
        object[] artifacts = manifest["artifacts"] as object[];
        if (artifacts == null || artifacts.Length != ReleaseArtifactNames.Length)
        {
            throw new Failure("invalid");
        }
        for (int i = 0; i < artifacts.Length; i++)
        {
            Dictionary<string, object> artifact = BootstrapRecord(
                artifacts[i],
                new string[] { "name", "sizeBytes", "sha256" }
            );
            BootstrapArtifact item = new BootstrapArtifact
            {
                Name = BootstrapText(artifact, "name"),
                Hash = BootstrapText(artifact, "sha256"),
            };
            if (item.Name != ReleaseArtifactNames[i])
            {
                throw new Failure("invalid");
            }
            item.Maximum = BootstrapMaximum(item.Name);
            item.Size = ValidateArtifactSize(BootstrapText(artifact, "sizeBytes"), item.Maximum);
            ValidateArtifactHash(item.Hash);
            result.Artifacts.Add(item);
        }
        Dictionary<string, object> deployment = BootstrapRecord(
            manifest["deployment"],
            new string[]
            {
                "authorityId",
                "publicKey",
                "endpoints",
                "verificationUri",
                "serverCaPem",
            }
        );
        if (BootstrapText(deployment, "publicKey") == result.PublicKey)
        {
            throw new Failure("invalid");
        }
        object[] arguments =
            new BootstrapJson(BootstrapText(config, "argumentsJson")).Read() as object[];
        if (
            arguments == null
            || arguments.Length < 1
            || arguments.Length > 5
            || arguments.Length % 2 != 1
        )
        {
            throw new Failure("invalid");
        }
        result.Command = arguments[0] as string;
        if (
            Array.IndexOf(
                new string[]
                {
                    "install",
                    "connect",
                    "pair",
                    "run",
                    "status",
                    "logout",
                    "renew-pairing",
                    "system-info",
                },
                result.Command
            ) < 0
        )
        {
            throw new Failure("invalid");
        }
        for (int i = 1; i < arguments.Length; i += 2)
        {
            string option = arguments[i] as string;
            string value = arguments[i + 1] as string;
            if (option == "--directory" && result.Destination == null)
            {
                result.Destination = Canonical(value);
            }
            else if (option == "--release-directory" && result.Offline == null)
            {
                result.Offline = Canonical(value);
            }
            else
            {
                throw new Failure("invalid");
            }
        }
        return result;
    }

    private static long BootstrapInteger(string value)
    {
        long number;
        if (
            value == null
            || !Regex.IsMatch(value, @"\A(0|[1-9][0-9]{0,18})\z")
            || !Int64.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out number)
        )
        {
            throw new Failure("invalid");
        }
        return number;
    }

    private static string BootstrapText(Dictionary<string, object> value, string key)
    {
        string text = value[key] as string;
        if (text == null)
        {
            throw new Failure("invalid");
        }
        return text;
    }

    private static Dictionary<string, object> BootstrapRecord(object raw, string[] fields)
    {
        Dictionary<string, object> value = raw as Dictionary<string, object>;
        if (value == null || value.Count != fields.Length)
        {
            throw new Failure("invalid");
        }
        foreach (string field in fields)
        {
            if (!value.ContainsKey(field))
            {
                throw new Failure("invalid");
            }
        }
        return value;
    }

    private sealed class BootstrapJson
    {
        private readonly string text;
        private int position;

        internal BootstrapJson(string value)
        {
            text = value;
        }

        internal object Read()
        {
            object value = Value(0);
            Space(text, ref position);
            if (position != text.Length)
            {
                throw new Failure("invalid");
            }
            return value;
        }

        private object Value(int depth)
        {
            if (depth > 8)
            {
                throw new Failure("limit");
            }
            Space(text, ref position);
            if (position >= text.Length)
            {
                throw new Failure("invalid");
            }
            char kind = text[position];
            if (kind == '"')
            {
                return JsonString(text, ref position);
            }
            if (kind == '{')
            {
                position++;
                Dictionary<string, object> value = new Dictionary<string, object>(
                    StringComparer.Ordinal
                );
                Space(text, ref position);
                if (position < text.Length && text[position] == '}')
                {
                    position++;
                    return value;
                }
                while (true)
                {
                    string key = JsonString(text, ref position);
                    if (value.ContainsKey(key) || value.Count >= 32)
                    {
                        throw new Failure("invalid");
                    }
                    Space(text, ref position);
                    Take(text, ref position, ':');
                    value.Add(key, Value(depth + 1));
                    Space(text, ref position);
                    if (position < text.Length && text[position] == '}')
                    {
                        position++;
                        return value;
                    }
                    Take(text, ref position, ',');
                    Space(text, ref position);
                }
            }
            if (kind == '[')
            {
                position++;
                List<object> values = new List<object>();
                Space(text, ref position);
                if (position < text.Length && text[position] == ']')
                {
                    position++;
                    return values.ToArray();
                }
                while (true)
                {
                    if (values.Count >= 32)
                    {
                        throw new Failure("limit");
                    }
                    values.Add(Value(depth + 1));
                    Space(text, ref position);
                    if (position < text.Length && text[position] == ']')
                    {
                        position++;
                        return values.ToArray();
                    }
                    Take(text, ref position, ',');
                }
            }
            if (text.Substring(position).StartsWith("null", StringComparison.Ordinal))
            {
                position += 4;
                return null;
            }
            throw new Failure("invalid");
        }
    }
}
