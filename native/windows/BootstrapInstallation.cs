// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

/// <summary>The installed release is verified and pinned before the connector process may start.</summary>
public static partial class NexaConnectorStateOwner
{
    private static int BootstrapResume(Owner owner, string directory, BootstrapConfig config)
    {
        using (PinnedPath directoryPin = OpenPath(owner, directory, true, false))
        {
            List<SafeFileHandle> pins = BootstrapPins(owner, directory, config);
            bool interactive = config.Command == "connect" || config.Command == "pair";
            try
            {
                return NexaConnectorBootstrapProcess.Run(
                    directory + "\\node.exe",
                    new string[]
                    {
                        directory + "\\nerva-connector.mjs",
                        config.Command,
                        "--installation",
                        directory,
                    },
                    directory,
                    interactive,
                    config.Cancellation
                );
            }
            finally
            {
                foreach (SafeFileHandle pin in pins)
                {
                    pin.Dispose();
                }
            }
        }
    }

    private static List<SafeFileHandle> BootstrapPins(
        Owner owner,
        string directory,
        BootstrapConfig config
    )
    {
        List<SafeFileHandle> pins = new List<SafeFileHandle>();
        try
        {
            using (PinnedPath path = OpenPath(owner, directory, true, false))
            {
                foreach (BootstrapArtifact artifact in config.Artifacts)
                {
                    SafeFileHandle file = Open(
                        path.Last,
                        artifact.Name,
                        ReadFileAccess,
                        1,
                        false,
                        null,
                        1
                    );
                    pins.Add(file);
                    VerifyArtifactHandle(
                        owner,
                        file,
                        true,
                        artifact.Maximum,
                        artifact.Size,
                        artifact.Hash,
                        null,
                        config.Cancellation
                    );
                    if (artifact.Name == "node.exe")
                    {
                        BootstrapNodeArchitecture(file, config.Architecture, artifact.Size);
                    }
                }
            }
            return pins;
        }
        catch
        {
            foreach (SafeFileHandle pin in pins)
            {
                pin.Dispose();
            }
            throw;
        }
    }

    private static void BootstrapInstalled(Owner owner, PinnedPath path, BootstrapConfig config)
    {
        using (
            SafeFileHandle manifest = Open(
                path.Last,
                "release.json",
                ReadFileAccess,
                1,
                false,
                null,
                1
            )
        )
        {
            CheckObject(manifest, false);
            CheckAcl(manifest, true, owner.Sid);
            if (
                new UTF8Encoding(false, true).GetString(ReadBytes(manifest, 131072))
                != config.Manifest
            )
            {
                throw new Failure("migration-required");
            }
        }
        using (
            SafeFileHandle key = Open(
                path.Last,
                "release-public.json",
                ReadFileAccess,
                1,
                false,
                null,
                1
            )
        )
        {
            CheckObject(key, false);
            CheckAcl(key, true, owner.Sid);
            Dictionary<string, object> pin = BootstrapRecord(
                new BootstrapJson(
                    new UTF8Encoding(false, true).GetString(ReadBytes(key, 16384))
                ).Read(),
                new string[] { "suite", "publicKey" }
            );
            if (
                BootstrapText(pin, "suite") != "ml-dsa-44+ed25519"
                || BootstrapText(pin, "publicKey") != config.PublicKey
            )
            {
                throw new Failure("untrusted");
            }
        }
        List<SafeFileHandle> files = BootstrapPins(
            owner,
            path == null ? null : PathFromBootstrap(path, owner),
            config
        );
        foreach (SafeFileHandle file in files)
        {
            file.Dispose();
        }
    }

    private static string PathFromBootstrap(PinnedPath path, Owner owner)
    {
        StringBuilder result = new StringBuilder(4097);
        uint length = GetFinalPathNameByHandleW(path.Last, result, (uint)result.Capacity, 0);
        if (
            length == 0
            || length >= result.Capacity
            || !result.ToString().StartsWith("\\\\?\\", StringComparison.Ordinal)
        )
        {
            throw new Failure("untrusted");
        }
        string actual = Canonical(result.ToString().Substring(4));
        if (!Inside(actual, owner.Root))
        {
            throw new Failure("untrusted");
        }
        return actual;
    }

    private static void BootstrapNodeArchitecture(
        SafeFileHandle file,
        string architecture,
        long size
    )
    {
        byte[] dos = BootstrapReadAt(file, 0, 64);
        if (dos[0] != 77 || dos[1] != 90)
        {
            throw new Failure("untrusted");
        }
        uint offset = BitConverter.ToUInt32(dos, 60);
        if (offset < 64 || offset > 1048576 || offset > size - 26)
        {
            throw new Failure("untrusted");
        }
        byte[] pe = BootstrapReadAt(file, offset, 26);
        if (
            BitConverter.ToUInt32(pe, 0) != 0x4550
            || BitConverter.ToUInt16(pe, 4) != (architecture == "x64" ? 0x8664 : 0xAA64)
            || BitConverter.ToUInt16(pe, 24) != 0x20b
        )
        {
            throw new Failure("untrusted");
        }
    }

    private static byte[] BootstrapReadAt(SafeFileHandle file, long offset, int count)
    {
        long actual;
        if (!SetFilePointerEx(file, offset, out actual, 0) || actual != offset)
        {
            throw LastError();
        }
        byte[] bytes = new byte[count];
        uint read;
        if (!Native.ReadFile(file, bytes, (uint)count, out read, IntPtr.Zero) || read != count)
        {
            throw new Failure("untrusted");
        }
        return bytes;
    }
}
