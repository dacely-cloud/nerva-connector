// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>Bootstrap staging, publication and recovery retain owned leases and exact artifact identities.</summary>
public static partial class NexaConnectorStateOwner
{
    private static void BootstrapStage(
        Owner owner,
        PinnedPath stage,
        BootstrapConfig config,
        BootstrapArtifact artifact
    )
    {
        try
        {
            using (
                SafeFileHandle existing = Open(
                    stage.Last,
                    artifact.Name,
                    ReadFileAccess,
                    1,
                    false,
                    null,
                    1
                )
            )
            {
                VerifyArtifactHandle(
                    owner,
                    existing,
                    true,
                    artifact.Maximum,
                    artifact.Size,
                    artifact.Hash,
                    null
                );
                return;
            }
        }
        catch (Failure error)
        {
            if (error.Code != "not-found")
            {
                throw;
            }
        }
        using (
            CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(
                config.Cancellation
            )
        )
        using (
            SafeFileHandle output = Open(
                stage.Last,
                artifact.Name,
                WriteFileAccess,
                2,
                false,
                Descriptor(owner.Sid),
                1,
                0x1000
            )
        )
        {
            deadline.CancelAfter(180000);
            if (config.Offline != null)
            {
                using (PinnedPath source = OpenPath(owner, config.Offline, false, false))
                using (
                    SafeFileHandle input = Open(
                        source.Last,
                        artifact.Name,
                        ReadFileAccess,
                        1,
                        false,
                        null,
                        1
                    )
                )
                {
                    VerifyArtifactHandle(
                        owner,
                        input,
                        Inside(config.Offline, owner.Root),
                        artifact.Maximum,
                        artifact.Size,
                        artifact.Hash,
                        output,
                        deadline.Token
                    );
                }
            }
            else
            {
                HttpWebRequest request = (HttpWebRequest)
                    WebRequest.Create(new Uri(new Uri(config.BaseUrl), artifact.Name));
                request.AllowAutoRedirect = false;
                request.Timeout = 30000;
                request.ReadWriteTimeout = 30000;
                request.UseDefaultCredentials = false;
                using (
                    CancellationTokenRegistration cancel = deadline.Token.Register(request.Abort)
                )
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if (
                        response.StatusCode != HttpStatusCode.OK
                        || (response.ContentLength != -1 && response.ContentLength != artifact.Size)
                    )
                    {
                        throw new Failure("untrusted");
                    }
                    using (Stream input = response.GetResponseStream())
                    {
                        ArtifactMetadata actual = TransferArtifact(
                            input,
                            new ArtifactHandleStream(output, true),
                            artifact.Size,
                            artifact.Maximum,
                            deadline.Token,
                            180000
                        );
                        if (actual.Sha256 != artifact.Hash)
                        {
                            throw new Failure("untrusted");
                        }
                    }
                }
            }
            if (!Native.FlushFileBuffers(output))
            {
                throw LastError();
            }
            SetArtifactDelete(output, false);
        }
    }

    private static Lease BootstrapLease(Owner owner, PinnedPath path, string directory)
    {
        Lease lease = new Lease
        {
            Directory = directory,
            Path = path,
            Identity = FileIdentity(path.Last),
            Purpose = "installation",
        };
        lease.Lock = Open(
            path.Last,
            LockName("installation", lease.Identity),
            WriteFileAccess,
            3,
            false,
            Descriptor(owner.Sid),
            0
        );
        try
        {
            CheckObject(lease.Lock, false);
            CheckAcl(lease.Lock, true, owner.Sid);
            Native.OVERLAPPED position = new Native.OVERLAPPED();
            if (!Native.LockFileEx(lease.Lock, 3, 0, 1, 0, ref position))
            {
                throw LastError();
            }
            return lease;
        }
        catch
        {
            lease.Lock.Dispose();
            throw;
        }
    }

    private static void BootstrapWrite(Owner owner, Lease lease, string name, string value)
    {
        byte[] expected = new UTF8Encoding(false, true).GetBytes(value);
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
                byte[] previous = ReadBytes(existing, 131072);
                if (previous.Length != expected.Length)
                {
                    throw new Failure("untrusted");
                }
                for (int i = 0; i < previous.Length; i++)
                {
                    if (previous[i] != expected[i])
                    {
                        throw new Failure("untrusted");
                    }
                }
                return;
            }
        }
        catch (Failure error)
        {
            if (error.Code != "not-found")
            {
                throw;
            }
        }
        CleanArtifactPartial(owner, lease.Path.Last, name + ".partial", 131072);
        Write(owner, lease, name, Convert.ToBase64String(expected), 131072, true);
    }

    private static void BootstrapWriteRoot(Owner owner, PinnedPath root, string name, string value)
    {
        using (
            SafeFileHandle file = Open(
                root.Last,
                name,
                WriteFileAccess,
                2,
                false,
                Descriptor(owner.Sid),
                1
            )
        )
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            new ArtifactHandleStream(file, true).Write(bytes, 0, bytes.Length);
            if (!Native.FlushFileBuffers(file))
            {
                throw LastError();
            }
        }
    }

    private static void BootstrapDelete(
        Owner owner,
        SafeFileHandle directory,
        string name,
        int maximum
    )
    {
        CleanArtifactPartial(owner, directory, name, maximum);
    }

    private static void BootstrapClean(Owner owner, PinnedPath stage, BootstrapConfig config)
    {
        foreach (BootstrapArtifact artifact in config.Artifacts)
        {
            BootstrapDelete(owner, stage.Last, artifact.Name, artifact.Maximum);
        }
        foreach (
            string name in new string[]
            {
                "release.json",
                "release-public.json",
                "install-request.json",
                "release.json.partial",
                "release-public.json.partial",
                "install-request.json.partial",
            }
        )
        {
            BootstrapDelete(owner, stage.Last, name, 131072);
        }
    }

    private static void BootstrapRemoveWork(
        Owner owner,
        PinnedPath root,
        string work,
        string identity
    )
    {
        using (
            SafeFileHandle directory = Open(
                root.Last,
                Path.GetFileName(work),
                ReadDirectory | 0x10000U,
                1,
                true,
                null,
                1
            )
        )
        {
            CheckObject(directory, true);
            CheckAcl(directory, true, owner.Sid);
            if (FileIdentity(directory) != identity || List(directory, identity).Length != 0)
            {
                throw new Failure("untrusted");
            }
            Delete(directory);
        }
    }

    private static void BootstrapRecoverStage(
        Owner owner,
        PinnedPath root,
        string work,
        BootstrapConfig config
    )
    {
        PinnedPath stage;
        try
        {
            stage = OpenPath(owner, work, true, false);
        }
        catch (Failure error)
        {
            if (error.Code == "not-found")
            {
                return;
            }
            throw;
        }
        using (stage)
        {
            Lease lease = BootstrapLease(owner, stage, work);
            try
            {
                foreach (string child in List(stage.Last, lease.Identity))
                {
                    ValidateBootstrapStageChild(child);
                }
                BootstrapClean(owner, stage, config);
                Delete(lease.Lock);
                lease.Lock.Dispose();
                stage.Dispose();
                BootstrapRemoveWork(owner, root, work, lease.Identity);
            }
            finally
            {
                lease.Lock.Dispose();
            }
        }
    }
}
