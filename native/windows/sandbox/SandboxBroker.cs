// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Principal;

/// <summary>Explicit offline qualification only: never enables a remote capability or enrolls a device.</summary>
internal static class SandboxBroker
{
    public static int Main(string[] arguments)
    {
        string phase = "arguments";
        try
        {
            if (arguments.Length != 1 || arguments[0] != "--qualify")
            {
                throw new InvalidOperationException("usage");
            }
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                Console.Out.WriteLine("{\"qualified\":false,\"phase\":\"windows-required\"}");
                return 2;
            }
            SandboxPolicy.Layout();
            string sid;
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity.User == null || identity.IsAnonymous)
                {
                    throw new InvalidOperationException("owner");
                }
                sid = identity.User.Value;
            }
            phase = "worker-image";
            string source = Path.Combine(
                Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),
                SandboxPolicy.WorkerName
            );
            using (SandboxPath input = new SandboxPath(source, sid, true, null, null))
            {
                byte[] bytes = SandboxPath.Read(input.Last, 262144);
                if (
                    bytes.Length != SandboxWorkerPin.Bytes
                    || bytes.Length < 512
                    || bytes[0] != 77
                    || bytes[1] != 90
                    || Digest(bytes) != SandboxWorkerPin.Sha256
                )
                {
                    throw new InvalidOperationException("worker-pin");
                }
                phase = "private-fixture";
                using (SandboxFixture fixture = new SandboxFixture())
                {
                    phase = "profile-image";
                    using (SandboxPath image = fixture.PublishWorker(bytes))
                    {
                        if (Digest(SandboxPath.Read(image.Last, 262144)) != SandboxWorkerPin.Sha256)
                        {
                            throw new InvalidOperationException("published-pin");
                        }
                        TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
                        try
                        {
                            listener.Start(1);
                            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
                            using (
                                Socket control = new Socket(
                                    AddressFamily.InterNetwork,
                                    SocketType.Stream,
                                    ProtocolType.Tcp
                                )
                            )
                            {
                                control.Connect(new IPEndPoint(IPAddress.Loopback, port));
                                using (Socket accepted = listener.AcceptSocket()) { }
                            }
                            phase = "lpac-worker";
                            using (
                                SandboxLaunch worker = new SandboxLaunch(
                                    fixture,
                                    image,
                                    SandboxWorkerMode.Probe,
                                    port
                                )
                            )
                            {
                                if (
                                    worker.Finish()
                                        != "NEXA_SANDBOX_WORKER_V1:"
                                            + Digest(
                                                System.Text.Encoding.ASCII.GetBytes(fixture.Nonce)
                                            )
                                            + "\n"
                                    || listener.Pending()
                                )
                                {
                                    throw new InvalidOperationException("worker-report");
                                }
                            }
                            phase = "job-close";
                            using (
                                SandboxLaunch waiting = new SandboxLaunch(
                                    fixture,
                                    image,
                                    SandboxWorkerMode.Wait,
                                    0
                                )
                            )
                            {
                                waiting.ProveKillOnClose();
                            }
                            fixture.VerifyCanaries();
                        }
                        finally
                        {
                            listener.Stop();
                        }
                    }
                    phase = "cleanup";
                }
            }
            Console.Out.WriteLine(
                "{\"qualified\":true,\"scope\":\"lpac-canaries-only\",\"workerSha256\":\""
                    + SandboxWorkerPin.Sha256
                    + "\",\"readHandle\":true,\"writeDenied\":true,\"excludedHandleDenied\":true,\"ambientDenied\":true,\"loopbackDenied\":true,\"childDenied\":true,\"killOnClose\":true}"
            );
            return 0;
        }
        catch
        {
            Console.Out.WriteLine("{\"qualified\":false,\"phase\":\"" + phase + "\"}");
            return 1;
        }
    }

    private static string Digest(byte[] bytes)
    {
        using (SHA256 hash = SHA256.Create())
        {
            return BitConverter
                .ToString(hash.ComputeHash(bytes))
                .Replace("-", "")
                .ToLowerInvariant();
        }
    }
}
