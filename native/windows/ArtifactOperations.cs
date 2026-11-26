// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>Descriptor-pinned bounded artifact communication shares the state owner's existing trust policy.</summary>
public static partial class NexaConnectorStateOwner
{
    internal const int MaximumArtifactBytes = 268435456;
    internal static readonly string[] ReleaseArtifactNames =
    {
        "nerva-connector.mjs",
        "node.exe",
        "NODE-LICENSE",
        "nerva-connector-state.exe",
        "nerva-connector-state.json",
        "nerva-connector-host.exe",
        "nerva-connector-host.json",
        "THIRD-PARTY-NOTICES.txt",
        "nerva-connector-host-worker.mjs",
    };

    internal sealed class ArtifactMetadata
    {
        internal readonly long SizeBytes;
        internal readonly string Sha256;

        internal ArtifactMetadata(long size, string hash)
        {
            SizeBytes = size;
            Sha256 = hash;
        }
    }

    internal static long ValidateArtifactSize(string value, int maximum)
    {
        long size;
        if (
            maximum < 1
            || maximum > MaximumArtifactBytes
            || value == null
            || !Regex.IsMatch(value, "^[1-9][0-9]{0,8}$")
            || !Int64.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out size)
            || size > maximum
        )
        {
            throw new Failure("limit");
        }
        return size;
    }

    internal static void ValidateArtifactHash(string value)
    {
        if (value == null || value.Length != 64 || !Regex.IsMatch(value, @"\A[a-f0-9]{64}\z"))
        {
            throw new Failure("invalid");
        }
    }

    private static int ArtifactBound(Dictionary<string, object> request)
    {
        if (!(request["maximumBytes"] is int))
        {
            throw new Failure("invalid");
        }
        int value = (int)request["maximumBytes"];
        if (value < 1 || value > MaximumArtifactBytes)
        {
            throw new Failure("limit");
        }
        return value;
    }

    private static Dictionary<string, object> ArtifactOperation(
        Owner owner,
        Dictionary<string, object> request,
        string operation
    )
    {
        if (operation == "artifact-describe")
        {
            Fields(request, "path", "maximumBytes");
        }
        else if (operation == "artifact-verify")
        {
            Fields(request, "path", "maximumBytes", "sizeBytes", "sha256");
        }
        else
        {
            Fields(
                request,
                "path",
                "maximumBytes",
                "sizeBytes",
                "sha256",
                "lease",
                "name",
                "replace"
            );
        }
        int maximum = ArtifactBound(request);
        long? expected =
            operation == "artifact-describe"
                ? (long?)null
                : ValidateArtifactSize(Text(request, "sizeBytes"), maximum);
        string hash = operation == "artifact-describe" ? null : Text(request, "sha256");
        if (hash != null)
        {
            ValidateArtifactHash(hash);
        }
        ArtifactMetadata metadata;
        if (operation == "artifact-install")
        {
            metadata = InstallArtifact(
                owner,
                GetLease(owner, Text(request, "lease")),
                Text(request, "name"),
                Text(request, "path"),
                maximum,
                expected.Value,
                hash,
                Flag(request, "replace")
            );
        }
        else
        {
            metadata = VerifyArtifactPath(owner, Text(request, "path"), maximum, expected, hash);
        }
        return new Dictionary<string, object>
        {
            { "sizeBytes", metadata.SizeBytes.ToString(CultureInfo.InvariantCulture) },
            { "sha256", metadata.Sha256 },
        };
    }

    private static ArtifactMetadata VerifyArtifactPath(
        Owner owner,
        string path,
        int maximum,
        long? expected,
        string hash
    )
    {
        string full = Canonical(path);
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
            return VerifyArtifactHandle(
                owner,
                file,
                owner.Managed(full),
                maximum,
                expected,
                hash,
                null
            );
        }
    }

    private static ArtifactMetadata VerifyArtifactHandle(
        Owner owner,
        SafeFileHandle file,
        bool secret,
        int maximum,
        long? expected,
        string hash,
        SafeFileHandle output,
        CancellationToken cancellation = default(CancellationToken)
    )
    {
        CheckObject(file, false);
        CheckAcl(file, secret, owner.Sid);
        string identity = FileIdentity(file);
        byte[] before = Information(file, 0, 40);
        long length = BitConverter.ToInt64(Information(file, 1, 24), 8);
        if (length < 1 || length > maximum || (expected.HasValue && length != expected.Value))
        {
            throw new Failure("limit");
        }
        ArtifactMetadata result = TransferArtifact(
            new ArtifactHandleStream(file, false),
            output == null ? null : new ArtifactHandleStream(output, true),
            length,
            maximum,
            cancellation
        );
        byte[] after = Information(file, 0, 40);
        CheckObject(file, false);
        CheckAcl(file, secret, owner.Sid);
        if (
            identity != FileIdentity(file)
            || BitConverter.ToInt64(Information(file, 1, 24), 8) != length
        )
        {
            throw new Failure("untrusted");
        }
        for (int i = 16; i < 32; i++)
        {
            if (before[i] != after[i])
            {
                throw new Failure("untrusted");
            }
        }
        if (hash != null && result.Sha256 != hash)
        {
            throw new Failure("untrusted");
        }
        return result;
    }

    internal static ArtifactMetadata TransferArtifact(
        Stream input,
        Stream output,
        long expected,
        int maximum,
        CancellationToken cancellation = default(CancellationToken),
        int maximumMilliseconds = 30000
    )
    {
        ValidateArtifactSize(expected.ToString(CultureInfo.InvariantCulture), maximum);
        if (maximumMilliseconds < 1 || maximumMilliseconds > 180000)
        {
            throw new Failure("limit");
        }
        byte[] buffer = new byte[262144];
        Stopwatch deadline = Stopwatch.StartNew();
        try
        {
            using (SHA256 digest = SHA256.Create())
            {
                long total = 0;
                while (total < expected)
                {
                    cancellation.ThrowIfCancellationRequested();
                    if (deadline.ElapsedMilliseconds > maximumMilliseconds)
                    {
                        throw new Failure("limit");
                    }
                    int count = input.Read(
                        buffer,
                        0,
                        (int)Math.Min(buffer.Length, expected - total)
                    );
                    if (count < 1 || count > Math.Min(buffer.Length, expected - total))
                    {
                        throw new Failure("untrusted");
                    }
                    digest.TransformBlock(buffer, 0, count, buffer, 0);
                    if (output != null)
                    {
                        output.Write(buffer, 0, count);
                    }
                    total += count;
                }
                cancellation.ThrowIfCancellationRequested();
                if (input.Read(buffer, 0, 1) != 0)
                {
                    throw new Failure("limit");
                }
                if (deadline.ElapsedMilliseconds > maximumMilliseconds)
                {
                    throw new Failure("limit");
                }
                digest.TransformFinalBlock(buffer, 0, 0);
                return new ArtifactMetadata(
                    total,
                    BitConverter.ToString(digest.Hash).Replace("-", "").ToLowerInvariant()
                );
            }
        }
        finally
        {
            Array.Clear(buffer, 0, buffer.Length);
        }
    }

    private static ArtifactMetadata InstallArtifact(
        Owner owner,
        Lease lease,
        string name,
        string source,
        int maximum,
        long expected,
        string hash,
        bool replace
    )
    {
        if (lease.Purpose != "installation")
        {
            throw new Failure("untrusted");
        }
        ValidateLeaf(name);
        if (Array.IndexOf(ReleaseArtifactNames, name) < 0)
        {
            throw new Failure("invalid");
        }
        CheckLease(owner, lease);
        string full = Canonical(source);
        using (PinnedPath parent = OpenPath(owner, Path.GetDirectoryName(full), false, false))
        using (
            SafeFileHandle input = Open(
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
            CheckObject(input, false);
            CheckAcl(input, owner.Managed(full), owner.Sid);
            try
            {
                using (
                    SafeFileHandle existing = Open(
                        lease.Path.Last,
                        name,
                        ReadFileAccess,
                        1,
                        false,
                        null,
                        1
                    )
                )
                {
                    CheckObject(existing, false);
                    CheckAcl(existing, true, owner.Sid);
                    if (!replace)
                    {
                        return VerifyArtifactHandle(
                            owner,
                            existing,
                            true,
                            maximum,
                            expected,
                            hash,
                            null
                        );
                    }
                }
            }
            catch (Failure error)
            {
                if (error.Code != "not-found")
                {
                    throw;
                }
            }
            string temporary = name + ".partial";
            CleanArtifactPartial(owner, lease.Path.Last, temporary, maximum);
            using (
                SafeFileHandle output = Open(
                    lease.Path.Last,
                    temporary,
                    WriteFileAccess,
                    2,
                    false,
                    Descriptor(owner.Sid),
                    1,
                    0x1000
                )
            )
            {
                bool published = false;
                try
                {
                    ArtifactMetadata result = VerifyArtifactHandle(
                        owner,
                        input,
                        owner.Managed(full),
                        maximum,
                        expected,
                        hash,
                        output
                    );
                    if (!Native.FlushFileBuffers(output))
                    {
                        throw LastError();
                    }
                    SetArtifactDelete(output, false);
                    Rename(output, lease.Path.Last, name, replace);
                    published = true;
                    return result;
                }
                finally
                {
                    if (!published)
                    {
                        SetArtifactDelete(output, true);
                    }
                }
            }
        }
    }

    private static void CleanArtifactPartial(
        Owner owner,
        SafeFileHandle directory,
        string name,
        int maximum
    )
    {
        try
        {
            using (
                SafeFileHandle partial = Open(
                    directory,
                    name,
                    ReadFileAccess | 0x10000U,
                    1,
                    false,
                    null,
                    1
                )
            )
            {
                CheckObject(partial, false);
                CheckAcl(partial, true, owner.Sid);
                long size = BitConverter.ToInt64(Information(partial, 1, 24), 8);
                if (size < 0 || size > maximum)
                {
                    throw new Failure("untrusted");
                }
                Delete(partial);
            }
        }
        catch (Failure error)
        {
            if (error.Code != "not-found")
            {
                throw;
            }
        }
    }

    private static void SetArtifactDelete(SafeFileHandle file, bool delete)
    {
        IntPtr buffer = Marshal.AllocHGlobal(4);
        try
        {
            Marshal.WriteInt32(buffer, delete ? 9 : 8);
            Native.IO_STATUS_BLOCK result;
            int status = Native.NtSetInformationFile(file, out result, buffer, 4, 64);
            if (
                status == unchecked((int)0xC0000003)
                || status == unchecked((int)0xC0000002)
                || status == unchecked((int)0xC00000BB)
            )
            {
                throw new Failure("unsupported");
            }
            if (status < 0)
            {
                throw Status(status);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
