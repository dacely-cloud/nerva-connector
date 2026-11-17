// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>A package-trusted precompiled bootstrap establishes private Windows storage before downloaded code runs.</summary>
public static class NexaConnectorReleaseBootstrap
{
    public static void Main()
    {
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false, true);
        try { Environment.ExitCode = NexaConnectorStateOwner.RunReleaseBootstrap(); }
        catch (Exception error) { Console.Error.WriteLine(NexaConnectorStateOwner.BootstrapFailureMessage(error)); Environment.ExitCode = error is OperationCanceledException ? 130 : 1; }
    }
}

/// <summary>Bootstrap filesystem effects reuse exactly the state owner's pinned native paths and DACL policy.</summary>
public static partial class NexaConnectorStateOwner
{
    internal sealed class BootstrapArtifact
    {
        internal string Name, Hash;
        internal long Size;
        internal int Maximum;
    }

    internal sealed class BootstrapConfig
    {
        internal string Architecture, PublicKey, BaseUrl, Manifest, Command, Destination, Offline;
        internal string Control;
        internal CancellationToken Cancellation;
        internal long Issued, Expires;
        internal readonly List<BootstrapArtifact> Artifacts = new List<BootstrapArtifact>();
    }

    internal static BootstrapConfig ValidateBootstrapConfig(string line)
    {
        if (line == null || line.Length > 262144) throw new Failure("limit");
        Dictionary<string, object> config = BootstrapRecord(new BootstrapJson(line).Read(), new string[] { "protocol", "architecture", "manifestBase64", "releasePublicKey", "baseUrl", "argumentsJson", "control" });
        if (BootstrapText(config, "protocol") != "nerva-connector-windows-bootstrap-v1") throw new Failure("invalid");
        BootstrapConfig result = new BootstrapConfig();
        result.Control = BootstrapText(config, "control");
        if (result.Control != "none" && result.Control != "stdin-v1") throw new Failure("invalid");
        result.Architecture = BootstrapText(config, "architecture");
        if (result.Architecture != "x64" && result.Architecture != "arm64") throw new Failure("invalid");
        result.PublicKey = BootstrapText(config, "releasePublicKey");
        if (!Regex.IsMatch(result.PublicKey, @"\A[A-Za-z0-9_-]{1792}\z")) throw new Failure("invalid");
        result.BaseUrl = BootstrapText(config, "baseUrl");
        Uri origin;
        if (!Uri.TryCreate(result.BaseUrl, UriKind.Absolute, out origin) || origin.Scheme != "https" || origin.UserInfo.Length != 0 || origin.Query.Length != 0 || origin.Fragment.Length != 0 || result.BaseUrl.Length > 2048 || !result.BaseUrl.EndsWith("/", StringComparison.Ordinal)) throw new Failure("invalid");
        string encoded = BootstrapText(config, "manifestBase64");
        byte[] bytes = Decode(encoded, 131072);
        result.Manifest = new UTF8Encoding(false, true).GetString(bytes);
        Dictionary<string, object> envelope = BootstrapRecord(new BootstrapJson(result.Manifest).Read(), new string[] { "manifest", "signature" });
        string signature = BootstrapText(envelope, "signature");
        if (signature.Length != 3312 || !Regex.IsMatch(signature, @"\A[A-Za-z0-9_-]+\z")) throw new Failure("invalid");
        Dictionary<string, object> manifest = BootstrapRecord(envelope["manifest"], new string[] { "protocol", "releaseId", "revision", "issuedAtMs", "expiresAtMs", "platform", "architecture", "artifacts", "deployment" });
        if (BootstrapText(manifest, "protocol") != "nerva-connector-release" || BootstrapText(manifest, "platform") != "win32" || BootstrapText(manifest, "architecture") != result.Architecture) throw new Failure("invalid");
        string releaseId = BootstrapText(manifest, "releaseId");
        if (!Regex.IsMatch(releaseId, @"\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\z")) throw new Failure("invalid");
        if (BootstrapInteger(BootstrapText(manifest, "revision")) < 1) throw new Failure("invalid");
        result.Issued = BootstrapInteger(BootstrapText(manifest, "issuedAtMs"));
        result.Expires = BootstrapInteger(BootstrapText(manifest, "expiresAtMs"));
        if (result.Expires <= result.Issued || result.Expires - result.Issued > 7776000000L) throw new Failure("invalid");
        object[] artifacts = manifest["artifacts"] as object[];
        if (artifacts == null || artifacts.Length != ReleaseArtifactNames.Length) throw new Failure("invalid");
        for (int i = 0; i < artifacts.Length; i++)
        {
            Dictionary<string, object> artifact = BootstrapRecord(artifacts[i], new string[] { "name", "sizeBytes", "sha256" });
            BootstrapArtifact item = new BootstrapArtifact { Name = BootstrapText(artifact, "name"), Hash = BootstrapText(artifact, "sha256") };
            if (item.Name != ReleaseArtifactNames[i]) throw new Failure("invalid");
            item.Maximum = BootstrapMaximum(item.Name);
            item.Size = ValidateArtifactSize(BootstrapText(artifact, "sizeBytes"), item.Maximum);
            ValidateArtifactHash(item.Hash);
            result.Artifacts.Add(item);
        }
        Dictionary<string, object> deployment = BootstrapRecord(manifest["deployment"], new string[] { "authorityId", "publicKey", "endpoints", "verificationUri", "serverCaPem" });
        if (BootstrapText(deployment, "publicKey") == result.PublicKey) throw new Failure("invalid");
        object[] arguments = new BootstrapJson(BootstrapText(config, "argumentsJson")).Read() as object[];
        if (arguments == null || arguments.Length < 1 || arguments.Length > 5 || arguments.Length % 2 != 1) throw new Failure("invalid");
        result.Command = arguments[0] as string;
        if (Array.IndexOf(new string[] { "install", "connect", "pair", "run", "status", "logout", "renew-pairing", "system-info" }, result.Command) < 0) throw new Failure("invalid");
        for (int i = 1; i < arguments.Length; i += 2)
        {
            string option = arguments[i] as string, value = arguments[i + 1] as string;
            if (option == "--directory" && result.Destination == null) result.Destination = Canonical(value);
            else if (option == "--release-directory" && result.Offline == null) result.Offline = Canonical(value);
            else throw new Failure("invalid");
        }
        return result;
    }

    internal static int RunReleaseBootstrap()
    {
        if (Environment.GetCommandLineArgs().Length != 1) throw new Failure("invalid");
        BootstrapConfig config = ValidateBootstrapConfig(ReadLine());
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        if (config.Control == "none" && Console.In.Peek() != -1) throw new Failure("invalid");
        CancellationTokenSource stop = new CancellationTokenSource();
        config.Cancellation = stop.Token;
        ConsoleCancelEventHandler interrupt = delegate(object sender, ConsoleCancelEventArgs arguments) { arguments.Cancel = true; CancelBootstrap(stop); };
        Console.CancelKeyPress += interrupt;
        try
        {
            if (config.Control == "stdin-v1")
            {
                Thread monitor = new Thread(delegate() { try { StringBuilder line = new StringBuilder(); while (line.Length <= 6) { int value = Console.In.Read(); if (value < 0 || value == 10) break; line.Append((char)value); } } catch (IOException) { } catch (ObjectDisposedException) { } finally { CancelBootstrap(stop); } });
                monitor.IsBackground = true;
                monitor.Start();
            }
            return BootstrapExecute(config);
        }
        finally { Console.CancelKeyPress -= interrupt; CancelBootstrap(stop); stop.Dispose(); }
    }

    private static void CancelBootstrap(CancellationTokenSource stop)
    {
        try { stop.Cancel(); } catch (ObjectDisposedException) { } catch (AggregateException) { }
    }

    private static int BootstrapExecute(BootstrapConfig config)
    {
        config.Cancellation.ThrowIfCancellationRequested();
        BootstrapSystemInfo system;
        GetNativeSystemInfo(out system);
        if ((config.Architecture == "x64" && system.Architecture != 9) || (config.Architecture == "arm64" && system.Architecture != 12)) throw new Failure("untrusted");
        using (Owner owner = new Owner())
        using (PinnedPath root = OpenPath(owner, owner.Root, true, true))
        using (SafeFileHandle bootstrapGate = BootstrapLease(owner, root, owner.Root).Lock)
        {
            string destination = config.Destination ?? owner.Root + "\\installation";
            ValidateBootstrapDestination(destination, owner.Root);
            foreach (string legacy in new string[] { "pairing.json", "ready.json", "device-key.json", "state\\device-key.json", "state\\device-key.pem", "state\\pairing-state", "state\\device.json" }) if (BootstrapExists(owner, owner.Root + "\\" + legacy)) throw new Failure("migration-required");
            BootstrapLegacyProfile(owner);
            if (BootstrapExists(owner, owner.Root + "\\bootstrap-pending.json")) throw new Failure("migration-required");
            string commitment;
            using (SHA256 digest = SHA256.Create()) commitment = BitConverter.ToString(digest.ComputeHash(Encoding.UTF8.GetBytes(config.Manifest))).Replace("-", "").ToLowerInvariant();
            string work = owner.Root + "\\bootstrap-" + commitment;
            foreach (string child in List(root.Last, FileIdentity(root.Last))) ValidateBootstrapStageLeaf(child, "bootstrap-" + commitment);
            bool installed = BootstrapExists(owner, destination + "\\ready.json");
            if (installed)
            {
                using (PinnedPath installedPath = OpenPath(owner, destination, true, false))
                {
                    BootstrapInstalled(owner, installedPath, config);
                    BootstrapRecoverStage(owner, root, work, config);
                    bootstrapGate.Dispose();
                    return config.Command == "install" ? 0 : BootstrapResume(owner, destination, config);
                }
            }
            if (Array.IndexOf(new string[] { "status", "run", "logout", "renew-pairing" }, config.Command) >= 0) throw new Failure("not-found");
            long now = checked((long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds);
            if (config.Issued > now || config.Expires <= now) throw new Failure("invalid");
            using (PinnedPath target = OpenPath(owner, destination, true, true))
            using (PinnedPath stage = OpenPath(owner, work, true, true))
            {
                Lease lease = BootstrapLease(owner, stage, work);
                bool safeCleanup = true;
                bool recognized = false;
                try
                {
                    foreach (string existing in List(stage.Last, lease.Identity)) ValidateBootstrapStageChild(existing);
                    recognized = true;
                    foreach (BootstrapArtifact artifact in config.Artifacts) BootstrapStage(owner, stage, config, artifact);
                    BootstrapWrite(owner, lease, "release.json", config.Manifest);
                    BootstrapWrite(owner, lease, "release-public.json", Json.Serialize(new Dictionary<string, object> { { "suite", "ml-dsa-44+ed25519" }, { "publicKey", config.PublicKey } }));
                    BootstrapWrite(owner, lease, "install-request.json", Json.Serialize(new Dictionary<string, object> { { "releaseDirectory", work }, { "manifestFile", work + "\\release.json" }, { "releasePublicKeyFile", work + "\\release-public.json" }, { "destination", destination } }));
                    List<SafeFileHandle> pins = BootstrapPins(owner, work, config);
                    bool quiescent = false;
                    try
                    {
                        config.Cancellation.ThrowIfCancellationRequested();
                        BootstrapWriteRoot(owner, root, "bootstrap-pending.json", Json.Serialize(new Dictionary<string, object> { { "protocol", "nerva-bootstrap-recovery-v1" }, { "commitment", commitment }, { "destination", destination } }));
                        int exit;
                        try { exit = NexaConnectorBootstrapProcess.Run(work + "\\node.exe", new string[] { work + "\\nerva-connector.mjs", "install", "--config", work + "\\install-request.json" }, work, false, config.Cancellation); }
                        catch (NexaConnectorBootstrapQuiescenceException) { safeCleanup = false; throw; }
                        catch { BootstrapDelete(owner, root.Last, "bootstrap-pending.json", 8192); throw; }
                        quiescent = true;
                        BootstrapDelete(owner, root.Last, "bootstrap-pending.json", 8192);
                        if (exit == 130) throw new OperationCanceledException(config.Cancellation);
                        if (exit != 0) throw new Failure("io");
                        BootstrapInstalled(owner, target, config);
                    }
                    finally
                    {
                        foreach (SafeFileHandle pin in pins) pin.Dispose();
                        if (!quiescent && !safeCleanup) Console.Error.WriteLine("Windows connector install recovery is required; pending state and staging were retained.");
                    }
                }
                finally
                {
                    try
                    {
                        if (safeCleanup && recognized)
                        {
                            BootstrapClean(owner, stage, config);
                            Delete(lease.Lock);
                            lease.Lock.Dispose();
                            stage.Dispose();
                            BootstrapRemoveWork(owner, root, work, lease.Identity);
                        }
                    }
                    finally { lease.Lock.Dispose(); }
                }
            }
            bootstrapGate.Dispose();
            return config.Command == "install" ? 0 : BootstrapResume(owner, destination, config);
        }
    }

    private static int BootstrapResume(Owner owner, string directory, BootstrapConfig config)
    {
        using (PinnedPath directoryPin = OpenPath(owner, directory, true, false))
        {
            List<SafeFileHandle> pins = BootstrapPins(owner, directory, config);
            bool interactive = config.Command == "connect" || config.Command == "pair";
            try { return NexaConnectorBootstrapProcess.Run(directory + "\\node.exe", new string[] { directory + "\\nerva-connector.mjs", config.Command, "--installation", directory }, directory, interactive, config.Cancellation); }
            finally { foreach (SafeFileHandle pin in pins) pin.Dispose(); }
        }
    }

    private static List<SafeFileHandle> BootstrapPins(Owner owner, string directory, BootstrapConfig config)
    {
        List<SafeFileHandle> pins = new List<SafeFileHandle>();
        try
        {
            using (PinnedPath path = OpenPath(owner, directory, true, false)) foreach (BootstrapArtifact artifact in config.Artifacts)
            {
                SafeFileHandle file = Open(path.Last, artifact.Name, ReadFileAccess, 1, false, null, 1);
                pins.Add(file);
                VerifyArtifactHandle(owner, file, true, artifact.Maximum, artifact.Size, artifact.Hash, null, config.Cancellation);
                if (artifact.Name == "node.exe") BootstrapNodeArchitecture(file, config.Architecture, artifact.Size);
            }
            return pins;
        }
        catch { foreach (SafeFileHandle pin in pins) pin.Dispose(); throw; }
    }

    private static void BootstrapInstalled(Owner owner, PinnedPath path, BootstrapConfig config)
    {
        using (SafeFileHandle manifest = Open(path.Last, "release.json", ReadFileAccess, 1, false, null, 1))
        {
            CheckObject(manifest, false); CheckAcl(manifest, true, owner.Sid);
            if (new UTF8Encoding(false, true).GetString(ReadBytes(manifest, 131072)) != config.Manifest) throw new Failure("migration-required");
        }
        using (SafeFileHandle key = Open(path.Last, "release-public.json", ReadFileAccess, 1, false, null, 1))
        {
            CheckObject(key, false); CheckAcl(key, true, owner.Sid);
            Dictionary<string, object> pin = BootstrapRecord(new BootstrapJson(new UTF8Encoding(false, true).GetString(ReadBytes(key, 16384))).Read(), new string[] { "suite", "publicKey" });
            if (BootstrapText(pin, "suite") != "ml-dsa-44+ed25519" || BootstrapText(pin, "publicKey") != config.PublicKey) throw new Failure("untrusted");
        }
        List<SafeFileHandle> files = BootstrapPins(owner, path == null ? null : PathFromBootstrap(path, owner), config);
        foreach (SafeFileHandle file in files) file.Dispose();
    }

    private static string PathFromBootstrap(PinnedPath path, Owner owner)
    {
        StringBuilder result = new StringBuilder(4097);
        uint length = GetFinalPathNameByHandleW(path.Last, result, (uint)result.Capacity, 0);
        if (length == 0 || length >= result.Capacity || !result.ToString().StartsWith("\\\\?\\", StringComparison.Ordinal)) throw new Failure("untrusted");
        string actual = Canonical(result.ToString().Substring(4));
        if (!Inside(actual, owner.Root)) throw new Failure("untrusted");
        return actual;
    }

    private static void BootstrapStage(Owner owner, PinnedPath stage, BootstrapConfig config, BootstrapArtifact artifact)
    {
        try
        {
            using (SafeFileHandle existing = Open(stage.Last, artifact.Name, ReadFileAccess, 1, false, null, 1)) { VerifyArtifactHandle(owner, existing, true, artifact.Maximum, artifact.Size, artifact.Hash, null); return; }
        }
        catch (Failure error) { if (error.Code != "not-found") throw; }
        using (CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(config.Cancellation))
        using (SafeFileHandle output = Open(stage.Last, artifact.Name, WriteFileAccess, 2, false, Descriptor(owner.Sid), 1, 0x1000))
        {
            deadline.CancelAfter(180000);
            if (config.Offline != null)
            {
                using (PinnedPath source = OpenPath(owner, config.Offline, false, false))
                using (SafeFileHandle input = Open(source.Last, artifact.Name, ReadFileAccess, 1, false, null, 1)) VerifyArtifactHandle(owner, input, Inside(config.Offline, owner.Root), artifact.Maximum, artifact.Size, artifact.Hash, output, deadline.Token);
            }
            else
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(new Uri(new Uri(config.BaseUrl), artifact.Name));
                request.AllowAutoRedirect = false; request.Timeout = 30000; request.ReadWriteTimeout = 30000; request.UseDefaultCredentials = false;
                using (CancellationTokenRegistration cancel = deadline.Token.Register(request.Abort))
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode != HttpStatusCode.OK || (response.ContentLength != -1 && response.ContentLength != artifact.Size)) throw new Failure("untrusted");
                    using (Stream input = response.GetResponseStream())
                    {
                        ArtifactMetadata actual = TransferArtifact(input, new ArtifactHandleStream(output, true), artifact.Size, artifact.Maximum, deadline.Token, 180000);
                        if (actual.Sha256 != artifact.Hash) throw new Failure("untrusted");
                    }
                }
            }
            if (!Native.FlushFileBuffers(output)) throw LastError();
            SetArtifactDelete(output, false);
        }
    }

    private static Lease BootstrapLease(Owner owner, PinnedPath path, string directory)
    {
        Lease lease = new Lease { Directory = directory, Path = path, Identity = FileIdentity(path.Last), Purpose = "installation" };
        lease.Lock = Open(path.Last, LockName("installation", lease.Identity), WriteFileAccess, 3, false, Descriptor(owner.Sid), 0);
        try { CheckObject(lease.Lock, false); CheckAcl(lease.Lock, true, owner.Sid); Native.OVERLAPPED position = new Native.OVERLAPPED(); if (!Native.LockFileEx(lease.Lock, 3, 0, 1, 0, ref position)) throw LastError(); return lease; }
        catch { lease.Lock.Dispose(); throw; }
    }

    private static void BootstrapWrite(Owner owner, Lease lease, string name, string value)
    {
        byte[] expected = new UTF8Encoding(false, true).GetBytes(value);
        try
        {
            using (SafeFileHandle existing = Open(lease.Path.Last, name, ReadFileAccess, 1, false, null, 1))
            {
                CheckObject(existing, false); CheckAcl(existing, true, owner.Sid);
                byte[] previous = ReadBytes(existing, 131072);
                if (previous.Length != expected.Length) throw new Failure("untrusted");
                for (int i = 0; i < previous.Length; i++) if (previous[i] != expected[i]) throw new Failure("untrusted");
                return;
            }
        }
        catch (Failure error) { if (error.Code != "not-found") throw; }
        CleanArtifactPartial(owner, lease.Path.Last, name + ".partial", 131072);
        Write(owner, lease, name, Convert.ToBase64String(expected), 131072, true);
    }
    private static void BootstrapWriteRoot(Owner owner, PinnedPath root, string name, string value)
    {
        using (SafeFileHandle file = Open(root.Last, name, WriteFileAccess, 2, false, Descriptor(owner.Sid), 1))
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            new ArtifactHandleStream(file, true).Write(bytes, 0, bytes.Length);
            if (!Native.FlushFileBuffers(file)) throw LastError();
        }
    }
    private static void BootstrapDelete(Owner owner, SafeFileHandle directory, string name, int maximum) { CleanArtifactPartial(owner, directory, name, maximum); }
    private static void BootstrapClean(Owner owner, PinnedPath stage, BootstrapConfig config)
    {
        foreach (BootstrapArtifact artifact in config.Artifacts) BootstrapDelete(owner, stage.Last, artifact.Name, artifact.Maximum);
        foreach (string name in new string[] { "release.json", "release-public.json", "install-request.json", "release.json.partial", "release-public.json.partial", "install-request.json.partial" }) BootstrapDelete(owner, stage.Last, name, 131072);
    }
    private static void BootstrapRemoveWork(Owner owner, PinnedPath root, string work, string identity)
    {
        using (SafeFileHandle directory = Open(root.Last, Path.GetFileName(work), ReadDirectory | 0x10000U, 1, true, null, 1))
        {
            CheckObject(directory, true); CheckAcl(directory, true, owner.Sid);
            if (FileIdentity(directory) != identity || List(directory, identity).Length != 0) throw new Failure("untrusted");
            Delete(directory);
        }
    }
    private static void BootstrapRecoverStage(Owner owner, PinnedPath root, string work, BootstrapConfig config)
    {
        PinnedPath stage;
        try { stage = OpenPath(owner, work, true, false); }
        catch (Failure error) { if (error.Code == "not-found") return; throw; }
        using (stage)
        {
            Lease lease = BootstrapLease(owner, stage, work);
            try
            {
                foreach (string child in List(stage.Last, lease.Identity)) ValidateBootstrapStageChild(child);
                BootstrapClean(owner, stage, config);
                Delete(lease.Lock);
                lease.Lock.Dispose();
                stage.Dispose();
                BootstrapRemoveWork(owner, root, work, lease.Identity);
            }
            finally { lease.Lock.Dispose(); }
        }
    }
    internal static void ValidateBootstrapStageLeaf(string name, string current)
    {
        if (name.StartsWith("bootstrap-", StringComparison.OrdinalIgnoreCase) && !String.Equals(name, current, StringComparison.OrdinalIgnoreCase)) throw new Failure("migration-required");
    }
    internal static void ValidateBootstrapDestination(string destination, string root)
    {
        if (!Inside(destination, root) || String.Equals(destination, root, StringComparison.OrdinalIgnoreCase)) throw new Failure("untrusted");
        string relative = destination.Substring(root.Length + 1);
        int separator = relative.IndexOf('\\');
        string first = separator < 0 ? relative : relative.Substring(0, separator);
        if (first.StartsWith("bootstrap-", StringComparison.OrdinalIgnoreCase)) throw new Failure("invalid");
    }
    internal static void ValidateBootstrapStageChild(string name)
    {
        if (Array.IndexOf(ReleaseArtifactNames, name) < 0 && Array.IndexOf(new string[] { "release.json", "release-public.json", "install-request.json", "release.json.partial", "release-public.json.partial", "install-request.json.partial" }, name) < 0) throw new Failure("untrusted");
    }
    private static void BootstrapLegacyProfile(Owner owner)
    {
        Guid folder = new Guid("5E6C858F-0E22-4760-9AFE-EA3317B67173");
        IntPtr value;
        if (Native.SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out value) != 0) throw new Failure("io");
        string profile;
        try { profile = Canonical(Marshal.PtrToStringUni(value)); } finally { Marshal.FreeCoTaskMem(value); }
        string previous = profile + "\\.local\\share\\nerva-connector";
        foreach (string leaf in new string[] { "state\\device-key.json", "state\\device-key.pem", "state\\pairing-state", "state\\device.json", "device-key.json", "pairing-state", "device.json" }) if (BootstrapExists(owner, previous + "\\" + leaf)) throw new Failure("migration-required");
    }
    private static bool BootstrapExists(Owner owner, string full)
    {
        try { using (PinnedPath parent = OpenPath(owner, Path.GetDirectoryName(full), false, false)) using (SafeFileHandle file = Open(parent.Last, Path.GetFileName(full), ReadFileAccess, 1, false, null, 1)) { CheckObject(file, false); CheckAcl(file, true, owner.Sid); return true; } }
        catch (Failure error) { if (error.Code == "not-found") return false; throw; }
    }
    private static int BootstrapMaximum(string name) { return name == "node.exe" ? MaximumArtifactBytes : name == "nerva-connector.mjs" ? 786432 : name.EndsWith(".json", StringComparison.Ordinal) ? 2048 : name.EndsWith(".exe", StringComparison.Ordinal) || name.EndsWith("worker.mjs", StringComparison.Ordinal) ? 262144 : name == "THIRD-PARTY-NOTICES.txt" ? 65536 : 1048576; }
    internal static string BootstrapFailureMessage(Exception error)
    {
        Failure native = error as Failure;
        if (native != null && native.Code == "unsupported") return "This Windows OS or filesystem lacks a required secure installation capability. Existing connector data was preserved.";
        if (native != null && native.Code == "migration-required") return "Existing connector identity or pending installation requires explicit recovery. No new identity was created.";
        if (native != null && native.Code == "busy") return "Another connector setup owns this private installation. Wait for it to finish before retrying.";
        if (error is NexaConnectorBootstrapQuiescenceException) return "Windows could not confirm installer shutdown. Recovery staging and its pending fence were retained.";
        if (error is OperationCanceledException) return "Windows connector setup was canceled; the existing connector identity was preserved.";
        return "Windows connector bootstrap could not complete securely. Existing installation and recovery state were preserved.";
    }
    private static long BootstrapInteger(string value) { long number; if (value == null || !Regex.IsMatch(value, @"\A(0|[1-9][0-9]{0,18})\z") || !Int64.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out number)) throw new Failure("invalid"); return number; }
    private static string BootstrapText(Dictionary<string, object> value, string key) { string text = value[key] as string; if (text == null) throw new Failure("invalid"); return text; }
    private static Dictionary<string, object> BootstrapRecord(object raw, string[] fields) { Dictionary<string, object> value = raw as Dictionary<string, object>; if (value == null || value.Count != fields.Length) throw new Failure("invalid"); foreach (string field in fields) if (!value.ContainsKey(field)) throw new Failure("invalid"); return value; }

    private static void BootstrapNodeArchitecture(SafeFileHandle file, string architecture, long size)
    {
        byte[] dos = BootstrapReadAt(file, 0, 64);
        if (dos[0] != 77 || dos[1] != 90) throw new Failure("untrusted");
        uint offset = BitConverter.ToUInt32(dos, 60);
        if (offset < 64 || offset > 1048576 || offset > size - 26) throw new Failure("untrusted");
        byte[] pe = BootstrapReadAt(file, offset, 26);
        if (BitConverter.ToUInt32(pe, 0) != 0x4550 || BitConverter.ToUInt16(pe, 4) != (architecture == "x64" ? 0x8664 : 0xAA64) || BitConverter.ToUInt16(pe, 24) != 0x20b) throw new Failure("untrusted");
    }
    private static byte[] BootstrapReadAt(SafeFileHandle file, long offset, int count)
    {
        long actual;
        if (!SetFilePointerEx(file, offset, out actual, 0) || actual != offset) throw LastError();
        byte[] bytes = new byte[count]; uint read;
        if (!Native.ReadFile(file, bytes, (uint)count, out read, IntPtr.Zero) || read != count) throw new Failure("untrusted");
        return bytes;
    }

    private sealed class BootstrapJson
    {
        private readonly string text;
        private int position;
        internal BootstrapJson(string value) { text = value; }
        internal object Read() { object value = Value(0); Space(text, ref position); if (position != text.Length) throw new Failure("invalid"); return value; }
        private object Value(int depth)
        {
            if (depth > 8) throw new Failure("limit");
            Space(text, ref position); if (position >= text.Length) throw new Failure("invalid");
            char kind = text[position];
            if (kind == '"') return JsonString(text, ref position);
            if (kind == '{')
            {
                position++; Dictionary<string, object> value = new Dictionary<string, object>(StringComparer.Ordinal); Space(text, ref position);
                if (position < text.Length && text[position] == '}') { position++; return value; }
                while (true) { string key = JsonString(text, ref position); if (value.ContainsKey(key) || value.Count >= 32) throw new Failure("invalid"); Space(text, ref position); Take(text, ref position, ':'); value.Add(key, Value(depth + 1)); Space(text, ref position); if (position < text.Length && text[position] == '}') { position++; return value; } Take(text, ref position, ','); Space(text, ref position); }
            }
            if (kind == '[')
            {
                position++; List<object> values = new List<object>(); Space(text, ref position);
                if (position < text.Length && text[position] == ']') { position++; return values.ToArray(); }
                while (true) { if (values.Count >= 32) throw new Failure("limit"); values.Add(Value(depth + 1)); Space(text, ref position); if (position < text.Length && text[position] == ']') { position++; return values.ToArray(); } Take(text, ref position, ','); }
            }
            if (text.Substring(position).StartsWith("null", StringComparison.Ordinal)) { position += 4; return null; }
            throw new Failure("invalid");
        }
    }

    [StructLayout(LayoutKind.Sequential)] private struct BootstrapSystemInfo { internal ushort Architecture, Reserved; internal uint PageSize; internal IntPtr Minimum, Maximum, Mask; internal uint Processors, Type, Granularity; internal ushort Level, Revision; }
    [DllImport("kernel32.dll")] private static extern void GetNativeSystemInfo(out BootstrapSystemInfo information);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetFilePointerEx(SafeFileHandle file, long distance, out long position, uint origin);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
}
