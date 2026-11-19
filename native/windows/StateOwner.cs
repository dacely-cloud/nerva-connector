// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

/// <summary>Fixed Windows communication owner; exposes no program execution or network access.</summary>
public static partial class NexaConnectorStateOwner
{
    /// <summary>The precompiled executable reads only operation requests from standard input.</summary>
    public static void Main()
    {
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false, true);
        Run();
    }

    private const int MaximumLine = 6291456;
    private const uint ReadDirectory = 0x001200A1;
    private const uint ReadFileAccess = 0x00120089;
    private const uint WriteFileAccess = 0xC0130000;
    private static readonly string[] RequestFields =
    {
        "id",
        "operation",
        "path",
        "purpose",
        "lease",
        "name",
        "maximumBytes",
        "dataBase64",
        "initialize",
        "secret",
        "sizeBytes",
        "sha256",
        "replace",
    };
    private static readonly string[] Purposes =
    {
        "installation",
        "runtime",
        "identity",
        "pairing",
    };
    private static readonly byte[] KeyHeader = Encoding.ASCII.GetBytes("NEXA-DPAPI-1\n");
    private static readonly byte[] KeyEntropy = Encoding.UTF8.GetBytes(
        "nexa-connector:windows:device-key:1"
    );
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer
    {
        MaxJsonLength = MaximumLine,
        RecursionLimit = 8,
    };

    private sealed class Failure : Exception
    {
        internal readonly string Code;
        internal readonly string Check;
        internal string Scope;

        internal Failure(string code, string check = null)
        {
            Code = code;
            Check = check;
        }
    }

    private sealed class PinnedPath : IDisposable
    {
        internal readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        internal SafeFileHandle Last
        {
            get { return Handles[Handles.Count - 1]; }
        }

        public void Dispose()
        {
            for (int i = Handles.Count - 1; i >= 0; i--)
            {
                Handles[i].Dispose();
            }
            Handles.Clear();
        }
    }

    private sealed class Lease : IDisposable
    {
        internal PinnedPath Path;
        internal SafeFileHandle Lock;
        internal string Directory;
        internal string Identity;
        internal string Purpose;

        public void Dispose()
        {
            if (Lock != null)
            {
                Lock.Dispose();
            }
            if (Path != null)
            {
                Path.Dispose();
            }
        }
    }

    private sealed class Owner : IDisposable
    {
        internal readonly string Sid;
        internal readonly string Base;
        internal readonly string Profile;
        internal readonly string Root;
        internal readonly string ProfileRoot;
        internal readonly Dictionary<string, Lease> Leases = new Dictionary<string, Lease>(
            StringComparer.Ordinal
        );
        internal readonly Dictionary<string, string> Volumes = new Dictionary<string, string>(
            StringComparer.OrdinalIgnoreCase
        );

        internal Owner()
            : this(
                CurrentSid(),
                KnownFolder("F1B32785-6FBA-4FCF-9D55-7B8E7F157091"),
                KnownFolder("5E6C858F-0E22-4760-9AFE-EA3317B67173")
            ) { }

        internal Owner(string sid, string localAppData, string profile)
        {
            Sid = sid;
            Base = localAppData;
            Profile = profile;
            Root = Base + "\\Nerva\\Connector";
            ProfileRoot = profile + "\\.nerva-connector-state";
            NativeRoot(Base);
        }

        private static string CurrentSid()
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity.User == null || identity.IsAnonymous)
                {
                    throw new Failure("untrusted");
                }
                return identity.User.Value;
            }
        }

        private static string KnownFolder(string folder)
        {
            Guid id = new Guid(folder);
            IntPtr value;
            if (Native.SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out value) != 0)
            {
                throw new Failure("io");
            }
            try
            {
                return Canonical(Marshal.PtrToStringUni(value));
            }
            finally
            {
                Marshal.FreeCoTaskMem(value);
            }
        }

        internal bool Managed(string path)
        {
            return Inside(path, Root) || Inside(path, ProfileRoot);
        }

        internal string NativeRoot(string path)
        {
            string drive = path.Substring(0, 2).ToUpperInvariant();
            string root;
            if (!Volumes.TryGetValue(drive, out root))
            {
                root = QueryVolume(drive);
                Volumes.Add(drive, root);
            }
            return root;
        }

        public void Dispose()
        {
            foreach (Lease lease in Leases.Values)
            {
                lease.Dispose();
            }
            Leases.Clear();
        }
    }

    /// <summary>Reads one bounded primitive-only JSON request at a time; EOF releases every kernel lease.</summary>
    public static void Run()
    {
        Owner owner = null;
        try
        {
            while (true)
            {
                string line;
                try
                {
                    line = ReadLine();
                }
                catch
                {
                    WriteReply("0", false, null, "limit");
                    break;
                }
                if (line == null)
                {
                    break;
                }
                string id = "0";
                try
                {
                    Dictionary<string, object> request = Parse(line);
                    string candidate = Text(request, "id");
                    if (
                        candidate.Length > 20
                        || !Regex.IsMatch(candidate, "^(0|[1-9][0-9]{0,19})$")
                    )
                    {
                        throw new Failure("invalid");
                    }
                    id = candidate;
                    if (owner == null)
                    {
                        owner = new Owner();
                    }
                    Dictionary<string, object> result = Dispatch(owner, request);
                    WriteReply(id, true, result, null);
                }
                catch (Failure error)
                {
                    string diagnostic =
                        error.Check == null
                            ? null
                            : (error.Scope ?? "state-object") + "/" + error.Check;
                    WriteReply(id, false, null, error.Code, diagnostic);
                }
                catch
                {
                    WriteReply(id, false, null, "io");
                }
            }
        }
        finally
        {
            if (owner != null)
            {
                owner.Dispose();
            }
        }
    }

    private static Dictionary<string, object> Dispatch(
        Owner owner,
        Dictionary<string, object> request
    )
    {
        string operation = Text(request, "operation");
        Dictionary<string, object> result = new Dictionary<string, object>();
        switch (operation)
        {
            case "gpu-inventory":
                Fields(request);
                result["dataBase64"] = Convert.ToBase64String(
                    Encoding.UTF8.GetBytes(Json.Serialize(NexaConnectorGpuInventory.Read()))
                );
                return result;
            case "root":
                Fields(request);
                result["path"] = DefaultStateRoot(owner);
                return result;
            case "directory":
                Fields(request, "path", "initialize");
                string directory = Canonical(Text(request, "path"));
                bool create = Flag(request, "initialize");
                if (create && !owner.Managed(directory))
                {
                    throw new Failure("untrusted");
                }
                using (PinnedPath path = OpenPath(owner, directory, true, create)) { }
                result["path"] = directory;
                return result;
            case "open":
                Fields(request, "path", "purpose");
                if (owner.Leases.Count >= 16)
                {
                    throw new Failure("limit");
                }
                string purpose = Text(request, "purpose");
                if (Array.IndexOf(Purposes, purpose) < 0)
                {
                    throw new Failure("invalid");
                }
                Lease lease = new Lease();
                try
                {
                    lease.Directory = Canonical(Text(request, "path"));
                    lease.Purpose = purpose;
                    lease.Path = OpenPath(owner, lease.Directory, true, false);
                    lease.Identity = FileIdentity(lease.Path.Last);
                    string lockName = LockName(purpose, lease.Identity);
                    lease.Lock = Open(
                        lease.Path.Last,
                        lockName,
                        WriteFileAccess,
                        3,
                        false,
                        Descriptor(owner.Sid),
                        0
                    );
                    CheckObject(lease.Lock, false);
                    CheckAcl(lease.Lock, true, owner.Sid);
                    Native.OVERLAPPED position = new Native.OVERLAPPED();
                    if (!Native.LockFileEx(lease.Lock, 3, 0, 1, 0, ref position))
                    {
                        throw LastError();
                    }
                    string token = RandomToken();
                    owner.Leases.Add(token, lease);
                    result["path"] = lease.Directory;
                    result["lease"] = token;
                    return result;
                }
                catch
                {
                    lease.Dispose();
                    throw;
                }
            case "close":
                Fields(request, "lease");
                string closing = Text(request, "lease");
                Lease closed = GetLease(owner, closing);
                owner.Leases.Remove(closing);
                closed.Dispose();
                return result;
            case "artifact-describe":
            case "artifact-verify":
            case "artifact-install":
                return ArtifactOperation(owner, request, operation);
            case "exists-path":
            case "read-path":
                Fields(
                    request,
                    operation == "read-path"
                        ? new string[] { "path", "maximumBytes", "secret" }
                        : new string[] { "path" }
                );
                string fullPath = Canonical(Text(request, "path"));
                using (
                    PinnedPath parent = OpenPath(
                        owner,
                        Path.GetDirectoryName(fullPath),
                        false,
                        false
                    )
                )
                {
                    string leaf = Path.GetFileName(fullPath);
                    bool secret = operation == "read-path" && Flag(request, "secret");
                    try
                    {
                        using (
                            SafeFileHandle file = Open(
                                parent.Last,
                                leaf,
                                ReadFileAccess,
                                1,
                                false,
                                null,
                                1
                            )
                        )
                        {
                            CheckObject(file, false);
                            CheckAcl(file, secret || IsKey(leaf), owner.Sid);
                            if (operation == "exists-path")
                            {
                                result["exists"] = true;
                            }
                            else
                            {
                                result["dataBase64"] = ReadEncoded(
                                    file,
                                    leaf,
                                    Bound(request),
                                    true
                                );
                            }
                        }
                    }
                    catch (Failure error)
                    {
                        if (operation != "exists-path" || error.Code != "not-found")
                        {
                            throw;
                        }
                        result["exists"] = false;
                    }
                }
                return result;
            case "exists":
            case "read":
            case "write":
            case "remove":
            case "clean-partial":
            case "list":
                return LeafOperation(owner, request, operation);
            default:
                throw new Failure("invalid");
        }
    }

    private static bool IsKey(string name)
    {
        return String.Equals(name, "device-key.json", StringComparison.OrdinalIgnoreCase)
            || String.Equals(name, "device-key.json.partial", StringComparison.OrdinalIgnoreCase);
    }

    private static Lease GetLease(Owner owner, string token)
    {
        Lease lease;
        if (!owner.Leases.TryGetValue(token, out lease))
        {
            throw new Failure("invalid");
        }
        return lease;
    }

    private static string RandomToken()
    {
        byte[] bytes = new byte[24];
        using (RandomNumberGenerator random = RandomNumberGenerator.Create())
        {
            random.GetBytes(bytes);
        }
        return Convert.ToBase64String(bytes);
    }

    private static Failure LastError()
    {
        int code = Marshal.GetLastWin32Error();
        if (code == 5)
        {
            return new Failure("untrusted", "access-denied");
        }
        return new Failure(
            code == 2 || code == 3 ? "not-found"
            : code == 32 || code == 33 ? "busy"
            : code == 80 || code == 183 ? "exists"
            : "io"
        );
    }

    private static Failure Status(int status)
    {
        if (status == unchecked((int)0xC0000022))
        {
            return new Failure("untrusted", "access-denied");
        }
        if (status == unchecked((int)0xC000050B) || status == unchecked((int)0xC0000279))
        {
            return new Failure("untrusted", "reparse-point");
        }
        return new Failure(
            status == unchecked((int)0xC0000034) || status == unchecked((int)0xC000003A)
                ? "not-found"
            : status == unchecked((int)0xC0000035) ? "exists"
            : status == unchecked((int)0xC0000043) || status == unchecked((int)0xC0000054) ? "busy"
            : "io"
        );
    }
}
