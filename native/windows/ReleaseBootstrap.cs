// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>A package-trusted precompiled bootstrap establishes private Windows storage before downloaded code runs.</summary>
public static class NexaConnectorReleaseBootstrap
{
    public static void Main()
    {
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false, true);
        try
        {
            Environment.ExitCode = NexaConnectorStateOwner.RunReleaseBootstrap();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(NexaConnectorStateOwner.BootstrapFailureMessage(error));
            Environment.ExitCode = error is OperationCanceledException ? 130 : 1;
        }
    }
}

/// <summary>Bootstrap filesystem effects reuse exactly the state owner's pinned native paths and DACL policy.</summary>
public static partial class NexaConnectorStateOwner
{
    internal static int RunReleaseBootstrap()
    {
        if (Environment.GetCommandLineArgs().Length != 1)
        {
            throw new Failure("invalid");
        }
        BootstrapConfig config = ValidateBootstrapConfig(ReadLine());
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        if (config.Control == "none" && Console.In.Peek() != -1)
        {
            throw new Failure("invalid");
        }
        CancellationTokenSource stop = new CancellationTokenSource();
        config.Cancellation = stop.Token;
        ConsoleCancelEventHandler interrupt = delegate(
            object sender,
            ConsoleCancelEventArgs arguments
        )
        {
            arguments.Cancel = true;
            CancelBootstrap(stop);
        };
        Console.CancelKeyPress += interrupt;
        try
        {
            if (config.Control == "stdin-v1")
            {
                Thread monitor = new Thread(
                    delegate()
                    {
                        try
                        {
                            StringBuilder line = new StringBuilder();
                            while (line.Length <= 6)
                            {
                                int value = Console.In.Read();
                                if (value < 0 || value == 10)
                                {
                                    break;
                                }
                                line.Append((char)value);
                            }
                        }
                        catch (IOException) { }
                        catch (ObjectDisposedException) { }
                        finally
                        {
                            CancelBootstrap(stop);
                        }
                    }
                );
                monitor.IsBackground = true;
                monitor.Start();
            }
            return BootstrapExecute(config);
        }
        finally
        {
            Console.CancelKeyPress -= interrupt;
            CancelBootstrap(stop);
            stop.Dispose();
        }
    }

    private static void CancelBootstrap(CancellationTokenSource stop)
    {
        try
        {
            stop.Cancel();
        }
        catch (ObjectDisposedException) { }
        catch (AggregateException) { }
    }

    private static int BootstrapExecute(BootstrapConfig config)
    {
        config.Cancellation.ThrowIfCancellationRequested();
        BootstrapSystemInfo system;
        GetNativeSystemInfo(out system);
        if (
            (config.Architecture == "x64" && system.Architecture != 9)
            || (config.Architecture == "arm64" && system.Architecture != 12)
        )
        {
            throw new Failure("untrusted");
        }
        using (Owner owner = new Owner())
        using (PinnedPath root = OpenPath(owner, owner.Root, true, true))
        using (SafeFileHandle bootstrapGate = BootstrapLease(owner, root, owner.Root).Lock)
        {
            string destination = config.Destination ?? owner.Root + "\\installation";
            ValidateBootstrapDestination(destination, owner.Root);
            foreach (
                string legacy in new string[]
                {
                    "pairing.json",
                    "ready.json",
                    "device-key.json",
                    "state\\device-key.json",
                    "state\\device-key.pem",
                    "state\\pairing-state",
                    "state\\device.json",
                }
            )
            {
                if (BootstrapExists(owner, owner.Root + "\\" + legacy))
                {
                    throw new Failure("migration-required");
                }
            }
            BootstrapLegacyProfile(owner);
            if (BootstrapExists(owner, owner.Root + "\\bootstrap-pending.json"))
            {
                throw new Failure("migration-required");
            }
            string commitment;
            using (SHA256 digest = SHA256.Create())
            {
                commitment = BitConverter
                    .ToString(digest.ComputeHash(Encoding.UTF8.GetBytes(config.Manifest)))
                    .Replace("-", "")
                    .ToLowerInvariant();
            }
            string work = owner.Root + "\\bootstrap-" + commitment;
            foreach (string child in List(root.Last, FileIdentity(root.Last)))
            {
                ValidateBootstrapStageLeaf(child, "bootstrap-" + commitment);
            }
            bool installed = BootstrapExists(owner, destination + "\\ready.json");
            if (installed)
            {
                using (PinnedPath installedPath = OpenPath(owner, destination, true, false))
                {
                    BootstrapInstalled(owner, installedPath, config);
                    BootstrapRecoverStage(owner, root, work, config);
                    bootstrapGate.Dispose();
                    return config.Command == "install"
                        ? 0
                        : BootstrapResume(owner, destination, config);
                }
            }
            if (
                Array.IndexOf(
                    new string[] { "status", "run", "logout", "renew-pairing" },
                    config.Command
                ) >= 0
            )
            {
                throw new Failure("not-found");
            }
            long now = checked(
                (long)
                    (
                        DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)
                    ).TotalMilliseconds
            );
            if (config.Issued > now || config.Expires <= now)
            {
                throw new Failure("invalid");
            }
            using (PinnedPath target = OpenPath(owner, destination, true, true))
            using (PinnedPath stage = OpenPath(owner, work, true, true))
            {
                Lease lease = BootstrapLease(owner, stage, work);
                bool safeCleanup = true;
                bool recognized = false;
                try
                {
                    foreach (string existing in List(stage.Last, lease.Identity))
                    {
                        ValidateBootstrapStageChild(existing);
                    }
                    recognized = true;
                    foreach (BootstrapArtifact artifact in config.Artifacts)
                    {
                        BootstrapStage(owner, stage, config, artifact);
                    }
                    BootstrapWrite(owner, lease, "release.json", config.Manifest);
                    BootstrapWrite(
                        owner,
                        lease,
                        "release-public.json",
                        Json.Serialize(
                            new Dictionary<string, object>
                            {
                                { "suite", "ml-dsa-44+ed25519" },
                                { "publicKey", config.PublicKey },
                            }
                        )
                    );
                    BootstrapWrite(
                        owner,
                        lease,
                        "install-request.json",
                        Json.Serialize(
                            new Dictionary<string, object>
                            {
                                { "releaseDirectory", work },
                                { "manifestFile", work + "\\release.json" },
                                { "releasePublicKeyFile", work + "\\release-public.json" },
                                { "destination", destination },
                            }
                        )
                    );
                    List<SafeFileHandle> pins = BootstrapPins(owner, work, config);
                    bool quiescent = false;
                    try
                    {
                        config.Cancellation.ThrowIfCancellationRequested();
                        BootstrapWriteRoot(
                            owner,
                            root,
                            "bootstrap-pending.json",
                            Json.Serialize(
                                new Dictionary<string, object>
                                {
                                    { "protocol", "nerva-bootstrap-recovery-v1" },
                                    { "commitment", commitment },
                                    { "destination", destination },
                                }
                            )
                        );
                        int exit;
                        try
                        {
                            exit = NexaConnectorBootstrapProcess.Run(
                                work + "\\node.exe",
                                new string[]
                                {
                                    work + "\\nerva-connector.mjs",
                                    "install",
                                    "--config",
                                    work + "\\install-request.json",
                                },
                                work,
                                false,
                                config.Cancellation
                            );
                        }
                        catch (NexaConnectorBootstrapQuiescenceException)
                        {
                            safeCleanup = false;
                            throw;
                        }
                        catch
                        {
                            BootstrapDelete(owner, root.Last, "bootstrap-pending.json", 8192);
                            throw;
                        }
                        quiescent = true;
                        BootstrapDelete(owner, root.Last, "bootstrap-pending.json", 8192);
                        if (exit == 130)
                        {
                            throw new OperationCanceledException(config.Cancellation);
                        }
                        if (exit != 0)
                        {
                            throw new Failure("io");
                        }
                        BootstrapInstalled(owner, target, config);
                    }
                    finally
                    {
                        foreach (SafeFileHandle pin in pins)
                        {
                            pin.Dispose();
                        }
                        if (!quiescent && !safeCleanup)
                        {
                            Console.Error.WriteLine(
                                "Windows connector install recovery is required; pending state and staging were retained."
                            );
                        }
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
                    finally
                    {
                        lease.Lock.Dispose();
                    }
                }
            }
            bootstrapGate.Dispose();
            return config.Command == "install" ? 0 : BootstrapResume(owner, destination, config);
        }
    }

    internal static void ValidateBootstrapStageLeaf(string name, string current)
    {
        if (
            name.StartsWith("bootstrap-", StringComparison.OrdinalIgnoreCase)
            && !String.Equals(name, current, StringComparison.OrdinalIgnoreCase)
        )
        {
            throw new Failure("migration-required");
        }
    }

    internal static void ValidateBootstrapDestination(string destination, string root)
    {
        if (
            !Inside(destination, root)
            || String.Equals(destination, root, StringComparison.OrdinalIgnoreCase)
        )
        {
            throw new Failure("untrusted");
        }
        string relative = destination.Substring(root.Length + 1);
        int separator = relative.IndexOf('\\');
        string first = separator < 0 ? relative : relative.Substring(0, separator);
        if (first.StartsWith("bootstrap-", StringComparison.OrdinalIgnoreCase))
        {
            throw new Failure("invalid");
        }
    }

    internal static void ValidateBootstrapStageChild(string name)
    {
        if (
            Array.IndexOf(ReleaseArtifactNames, name) < 0
            && Array.IndexOf(
                new string[]
                {
                    "release.json",
                    "release-public.json",
                    "install-request.json",
                    "release.json.partial",
                    "release-public.json.partial",
                    "install-request.json.partial",
                },
                name
            ) < 0
        )
        {
            throw new Failure("untrusted");
        }
    }

    private static void BootstrapLegacyProfile(Owner owner)
    {
        Guid folder = new Guid("5E6C858F-0E22-4760-9AFE-EA3317B67173");
        IntPtr value;
        if (Native.SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out value) != 0)
        {
            throw new Failure("io");
        }
        string profile;
        try
        {
            profile = Canonical(Marshal.PtrToStringUni(value));
        }
        finally
        {
            Marshal.FreeCoTaskMem(value);
        }
        string previous = profile + "\\.local\\share\\nerva-connector";
        foreach (
            string leaf in new string[]
            {
                "state\\device-key.json",
                "state\\device-key.pem",
                "state\\pairing-state",
                "state\\device.json",
                "device-key.json",
                "pairing-state",
                "device.json",
            }
        )
        {
            if (BootstrapExists(owner, previous + "\\" + leaf))
            {
                throw new Failure("migration-required");
            }
        }
    }

    private static bool BootstrapExists(Owner owner, string full)
    {
        try
        {
            using (PinnedPath parent = OpenPath(owner, Path.GetDirectoryName(full), false, false))
            using (
                SafeFileHandle file = Open(
                    parent.Last,
                    Path.GetFileName(full),
                    ReadFileAccess,
                    1,
                    false,
                    null,
                    1
                )
            )
            {
                CheckObject(file, false);
                CheckAcl(file, true, owner.Sid);
                return true;
            }
        }
        catch (Failure error)
        {
            if (error.Code == "not-found")
            {
                return false;
            }
            throw;
        }
    }

    private static int BootstrapMaximum(string name)
    {
        return name == "node.exe" ? MaximumArtifactBytes
            : name == "nerva-connector.mjs" ? 786432
            : name.EndsWith(".json", StringComparison.Ordinal) ? 2048
            : name.EndsWith(".exe", StringComparison.Ordinal)
            || name.EndsWith("worker.mjs", StringComparison.Ordinal)
                ? 262144
            : name == "THIRD-PARTY-NOTICES.txt" ? 65536
            : 1048576;
    }

    internal static string BootstrapFailureMessage(Exception error)
    {
        Failure native = error as Failure;
        if (native != null && native.Code == "unsupported")
        {
            return "This Windows OS or filesystem lacks a required secure installation capability. Existing connector data was preserved.";
        }
        if (native != null && native.Code == "migration-required")
        {
            return "Existing connector identity or pending installation requires explicit recovery. No new identity was created.";
        }
        if (native != null && native.Code == "busy")
        {
            return "Another connector setup owns this private installation. Wait for it to finish before retrying.";
        }
        if (error is NexaConnectorBootstrapQuiescenceException)
        {
            return "Windows could not confirm installer shutdown. Recovery staging and its pending fence were retained.";
        }
        if (error is OperationCanceledException)
        {
            return "Windows connector setup was canceled; the existing connector identity was preserved.";
        }
        return "Windows connector bootstrap could not complete securely. Existing installation and recovery state were preserved.";
    }
}
