// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;

/// <summary>Portable checks exercise the actual C# parser, artifact bounds, complete streamed hashes and cancellation without Windows APIs.</summary>
public static class WindowsBootstrapNativeFixture
{
    private static int assertions;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 262144, RecursionLimit = 16 };
    private static void Reject(Action action) { try { action(); } catch { assertions++; return; } throw new Exception("Unsafe bootstrap input accepted"); }
    private static void Equal(object left, object right) { if (!Object.Equals(left, right)) throw new Exception("Bootstrap result changed"); assertions++; }

    public static void Main()
    {
        Equal(NexaConnectorStateOwner.ValidateArtifactSize("268435456", 268435456), 268435456L);
        foreach (string size in new string[] { "0", "01", "-1", "268435457", "9007199254740993", "1\n" }) Reject(delegate { NexaConnectorStateOwner.ValidateArtifactSize(size, 268435456); });
        Reject(delegate { NexaConnectorStateOwner.ValidateArtifactSize("10", 9); });
        Reject(delegate { NexaConnectorStateOwner.ValidateArtifactSize("1", 0); });
        foreach (string hash in new string[] { new string('A', 64), new string('a', 63), new string('a', 64) + "\n", new string('a', 64) + "\r\n" }) Reject(delegate { NexaConnectorStateOwner.ValidateArtifactHash(hash); });
        NexaConnectorStateOwner.ValidateArtifactHash(new string('a', 64)); assertions++;
        NexaConnectorStateOwner.ValidateBootstrapStageLeaf("bootstrap-" + new string('a', 64), "bootstrap-" + new string('a', 64)); assertions++;
        NexaConnectorStateOwner.ValidateBootstrapStageLeaf("installation", "bootstrap-" + new string('a', 64)); assertions++;
        Reject(delegate { NexaConnectorStateOwner.ValidateBootstrapStageLeaf("bootstrap-" + new string('b', 64), "bootstrap-" + new string('a', 64)); });
        Reject(delegate { NexaConnectorStateOwner.ValidateBootstrapStageChild("device-key.json"); });
        Reject(delegate { NexaConnectorStateOwner.ValidateBootstrapStageChild("user-project.txt"); });
        NexaConnectorStateOwner.ValidateBootstrapStageChild("release.json.partial"); assertions++;
        string root = "C:\\Users\\fixture\\AppData\\Local\\Nerva\\Connector";
        NexaConnectorStateOwner.ValidateBootstrapDestination(root + "\\installation", root); assertions++;
        NexaConnectorStateOwner.ValidateBootstrapDestination(root + "\\custom\\installation", root); assertions++;
        foreach (string destination in new string[] { root, "C:\\elsewhere", root + "\\bootstrap-" + new string('a', 64), root + "\\BOOTSTRAP-" + new string('a', 64) + "\\installation", root + "\\bootstrap-pending.json" }) Reject(delegate { NexaConnectorStateOwner.ValidateBootstrapDestination(destination, root); });

        byte[] bytes = new byte[3 * 1048576 + 17];
        for (int i = 0; i < bytes.Length; i++) bytes[i] = (byte)((i * 17) % 251);
        using (MemoryStream input = new MemoryStream(bytes, false))
        using (MemoryStream output = new MemoryStream())
        using (SHA256 digest = SHA256.Create())
        {
            NexaConnectorStateOwner.ArtifactMetadata actual = NexaConnectorStateOwner.TransferArtifact(input, output, bytes.Length, bytes.Length);
            Equal(actual.SizeBytes, (long)bytes.Length);
            Equal(actual.Sha256, BitConverter.ToString(digest.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant());
            Equal(output.Length, (long)bytes.Length);
            Equal(Convert.ToBase64String(output.ToArray()), Convert.ToBase64String(bytes));
        }
        Reject(delegate { using (MemoryStream input = new MemoryStream(new byte[9])) NexaConnectorStateOwner.TransferArtifact(input, null, 10, 10); });
        Reject(delegate { using (MemoryStream input = new MemoryStream(new byte[11])) NexaConnectorStateOwner.TransferArtifact(input, null, 10, 10); });
        Reject(delegate { using (MemoryStream input = new MemoryStream(new byte[1])) NexaConnectorStateOwner.TransferArtifact(input, null, 1, 1, CancellationToken.None, 180001); });
        Reject(delegate { using (DelayedStream input = new DelayedStream()) NexaConnectorStateOwner.TransferArtifact(input, null, 1, 1, CancellationToken.None, 1); });
        using (DelayedStream input = new DelayedStream()) Equal(NexaConnectorStateOwner.TransferArtifact(input, null, 1, 1, CancellationToken.None, 1000).Sha256, "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d");
        using (CancellationTokenSource stop = new CancellationTokenSource())
        {
            stop.Cancel();
            Reject(delegate { using (MemoryStream input = new MemoryStream(bytes)) NexaConnectorStateOwner.TransferArtifact(input, null, bytes.Length, bytes.Length, stop.Token); });
        }
        Dictionary<string, object> config = Config();
        NexaConnectorStateOwner.BootstrapConfig valid = NexaConnectorStateOwner.ValidateBootstrapConfig(Json.Serialize(config));
        Equal(valid.Artifacts.Count, 9); Equal(valid.Command, "connect"); Equal(valid.Control, "none");
        foreach (string field in new string[] { "protocol", "architecture", "control" })
        {
            Dictionary<string, object> changed = Config(); changed[field] = "unrecognized";
            Reject(delegate { NexaConnectorStateOwner.ValidateBootstrapConfig(Json.Serialize(changed)); });
        }
        foreach (string url in new string[] { "http://example.test/", "https://user@example.test/", "https://example.test/?secret=1", "https://example.test/#fragment", "https://example.test/no-slash" })
        {
            Dictionary<string, object> changed = Config(); changed["baseUrl"] = url;
            Reject(delegate { NexaConnectorStateOwner.ValidateBootstrapConfig(Json.Serialize(changed)); });
        }
        foreach (string arguments in new string[] { "[]", "[\"service\"]", "[\"connect\",\"--directory\"]", "[\"connect\",\"--program\",\"cmd.exe\"]", "[true]" })
        {
            Dictionary<string, object> changed = Config(); changed["argumentsJson"] = arguments;
            Reject(delegate { NexaConnectorStateOwner.ValidateBootstrapConfig(Json.Serialize(changed)); });
        }
        Reject(delegate { NexaConnectorStateOwner.ValidateBootstrapConfig(Json.Serialize(Config()).Replace("\"control\":\"none\"", "\"control\":\"none\",\"control\":\"none\"")); });
        Reject(delegate { Dictionary<string, object> changed = Config(); changed["manifestBase64"] = ((string)changed["manifestBase64"]) + "\n"; NexaConnectorStateOwner.ValidateBootstrapConfig(Json.Serialize(changed)); });
        Console.WriteLine("windows-bootstrap-native-checks=" + assertions);
    }

    private sealed class DelayedStream : MemoryStream
    {
        internal DelayedStream() : base(new byte[1], false) { }
        public override int Read(byte[] buffer, int offset, int count) { Thread.Sleep(40); return base.Read(buffer, offset, count); }
    }

    private static Dictionary<string, object> Config()
    {
        List<object> artifacts = new List<object>();
        foreach (string name in NexaConnectorStateOwner.ReleaseArtifactNames) artifacts.Add(new Dictionary<string, object> { { "name", name }, { "sizeBytes", "512" }, { "sha256", new string('a', 64) } });
        Dictionary<string, object> manifest = new Dictionary<string, object> {
            { "protocol", "nerva-connector-release" }, { "releaseId", "release:windows-v1" }, { "revision", "1" }, { "issuedAtMs", "1" }, { "expiresAtMs", "2" }, { "platform", "win32" }, { "architecture", "x64" }, { "artifacts", artifacts.ToArray() },
            { "deployment", new Dictionary<string, object> { { "authorityId", "fixture" }, { "publicKey", new string('B', 1792) }, { "endpoints", new string[] { "wss://example.test/connector" } }, { "verificationUri", "https://example.test/connect" }, { "serverCaPem", null } } }
        };
        string envelope = Json.Serialize(new Dictionary<string, object> { { "manifest", manifest }, { "signature", new string('A', 3312) } });
        return new Dictionary<string, object> { { "protocol", "nerva-connector-windows-bootstrap-v1" }, { "architecture", "x64" }, { "manifestBase64", Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(envelope)) }, { "releasePublicKey", new string('A', 1792) }, { "baseUrl", "https://example.test/releases/" }, { "argumentsJson", "[\"connect\"]" }, { "control", "none" } };
    }
}
