// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
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

    private const int MaximumLine = 1500000;
    private const uint ReadDirectory = 0x001200A1;
    private const uint ReadFileAccess = 0x00120089;
    private const uint WriteFileAccess = 0xC0130000;
    private static readonly string[] RequestFields = { "id", "operation", "path", "purpose", "lease", "name", "maximumBytes", "dataBase64", "initialize", "secret", "sizeBytes", "sha256", "replace" };
    private static readonly string[] Purposes = { "installation", "runtime", "identity", "pairing" };
    private static readonly byte[] KeyHeader = Encoding.ASCII.GetBytes("NEXA-DPAPI-1\n");
    private static readonly byte[] KeyEntropy = Encoding.UTF8.GetBytes("nexa-connector:windows:device-key:1");
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaximumLine, RecursionLimit = 8 };

    private sealed class Failure : Exception
    {
        internal readonly string Code;
        internal Failure(string code) { Code = code; }
    }

    private sealed class PinnedPath : IDisposable
    {
        internal readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        internal SafeFileHandle Last { get { return Handles[Handles.Count - 1]; } }
        public void Dispose() { for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Dispose(); Handles.Clear(); }
    }

    private sealed class Lease : IDisposable
    {
        internal PinnedPath Path;
        internal SafeFileHandle Lock;
        internal string Directory;
        internal string Identity;
        internal string Purpose;
        public void Dispose() { if (Lock != null) Lock.Dispose(); if (Path != null) Path.Dispose(); }
    }

    private sealed class Owner : IDisposable
    {
        internal readonly string Sid;
        internal readonly string Base;
        internal readonly string Root;
        internal readonly Dictionary<string, Lease> Leases = new Dictionary<string, Lease>(StringComparer.Ordinal);
        internal readonly Dictionary<string, string> Volumes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        internal Owner()
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity.User == null || identity.IsAnonymous) throw new Failure("untrusted");
                Sid = identity.User.Value;
            }
            Guid id = new Guid("F1B32785-6FBA-4FCF-9D55-7B8E7F157091");
            IntPtr value;
            if (Native.SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out value) != 0) throw new Failure("io");
            try { Base = Canonical(Marshal.PtrToStringUni(value)); }
            finally { Marshal.FreeCoTaskMem(value); }
            Root = Base + "\\Nerva\\Connector";
            NativeRoot(Base);
        }
        internal string NativeRoot(string path)
        {
            string drive = path.Substring(0, 2).ToUpperInvariant();
            string root;
            if (!Volumes.TryGetValue(drive, out root)) { root = QueryVolume(drive); Volumes.Add(drive, root); }
            return root;
        }
        public void Dispose() { foreach (Lease lease in Leases.Values) lease.Dispose(); Leases.Clear(); }
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
                try { line = ReadLine(); } catch { WriteReply("0", false, null, "limit"); break; }
                if (line == null) break;
                string id = "0";
                try
                {
                    Dictionary<string, object> request = Parse(line);
                    string candidate = Text(request, "id");
                    if (candidate.Length > 20 || !Regex.IsMatch(candidate, "^(0|[1-9][0-9]{0,19})$")) throw new Failure("invalid");
                    id = candidate;
                    if (owner == null) owner = new Owner();
                    Dictionary<string, object> result = Dispatch(owner, request);
                    WriteReply(id, true, result, null);
                }
                catch (Failure error) { WriteReply(id, false, null, error.Code); }
                catch { WriteReply(id, false, null, "io"); }
            }
        }
        finally { if (owner != null) owner.Dispose(); }
    }

    private static Dictionary<string, object> Dispatch(Owner owner, Dictionary<string, object> request)
    {
        string operation = Text(request, "operation");
        Dictionary<string, object> result = new Dictionary<string, object>();
        switch (operation)
        {
            case "gpu-inventory":
                Fields(request);
                result["dataBase64"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(Json.Serialize(NexaConnectorGpuInventory.Read())));
                return result;
            case "root":
                Fields(request);
                using (PinnedPath basePath = OpenPath(owner, owner.Base, false, false)) { }
                result["path"] = owner.Root;
                return result;
            case "directory":
                Fields(request, "path", "initialize");
                string directory = Canonical(Text(request, "path"));
                bool create = Flag(request, "initialize");
                if (create && !Inside(directory, owner.Root)) throw new Failure("untrusted");
                using (PinnedPath path = OpenPath(owner, directory, true, create)) { }
                result["path"] = directory;
                return result;
            case "open":
                Fields(request, "path", "purpose");
                if (owner.Leases.Count >= 16) throw new Failure("limit");
                string purpose = Text(request, "purpose");
                if (Array.IndexOf(Purposes, purpose) < 0) throw new Failure("invalid");
                Lease lease = new Lease();
                try
                {
                    lease.Directory = Canonical(Text(request, "path"));
                    lease.Purpose = purpose;
                    lease.Path = OpenPath(owner, lease.Directory, true, false);
                    lease.Identity = FileIdentity(lease.Path.Last);
                    string lockName = LockName(purpose, lease.Identity);
                    lease.Lock = Open(lease.Path.Last, lockName, WriteFileAccess, 3, false, Descriptor(owner.Sid), 0);
                    CheckObject(lease.Lock, false);
                    CheckAcl(lease.Lock, true, owner.Sid);
                    Native.OVERLAPPED position = new Native.OVERLAPPED();
                    if (!Native.LockFileEx(lease.Lock, 3, 0, 1, 0, ref position)) throw LastError();
                    string token = RandomToken();
                    owner.Leases.Add(token, lease);
                    result["path"] = lease.Directory;
                    result["lease"] = token;
                    return result;
                }
                catch { lease.Dispose(); throw; }
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
                Fields(request, operation == "read-path" ? new string[] { "path", "maximumBytes", "secret" } : new string[] { "path" });
                string fullPath = Canonical(Text(request, "path"));
                using (PinnedPath parent = OpenPath(owner, Path.GetDirectoryName(fullPath), false, false))
                {
                    string leaf = Path.GetFileName(fullPath);
                    bool secret = operation == "read-path" && Flag(request, "secret");
                    try
                    {
                        using (SafeFileHandle file = Open(parent.Last, leaf, ReadFileAccess, 1, false, null, 1))
                        {
                            CheckObject(file, false); CheckAcl(file, secret || IsKey(leaf), owner.Sid);
                            if (operation == "exists-path") result["exists"] = true;
                            else result["dataBase64"] = ReadEncoded(file, leaf, Bound(request), true);
                        }
                    }
                    catch (Failure error) { if (operation != "exists-path" || error.Code != "not-found") throw; result["exists"] = false; }
                }
                return result;
            case "exists":
            case "read":
            case "write":
            case "remove":
            case "clean-partial":
            case "list":
                return LeafOperation(owner, request, operation);
            default: throw new Failure("invalid");
        }
    }

    private static Dictionary<string, object> LeafOperation(Owner owner, Dictionary<string, object> request, string operation)
    {
        if (operation == "list") Fields(request, "lease");
        else if (operation == "exists") Fields(request, "lease", "name");
        else if (operation == "write") Fields(request, "lease", "name", "maximumBytes", "dataBase64", "initialize");
        else Fields(request, "lease", "name", "maximumBytes");
        Lease lease = GetLease(owner, Text(request, "lease"));
        CheckAcl(lease.Path.Last, true, owner.Sid);
        if (lease.Identity != FileIdentity(lease.Path.Last)) throw new Failure("untrusted");
        Dictionary<string, object> result = new Dictionary<string, object>();
        if (operation == "list") { result["names"] = List(lease.Path.Last, lease.Identity); return result; }
        string name = Text(request, "name");
        ValidateLeaf(name);
        if (name.StartsWith(".nexa-lock-", StringComparison.OrdinalIgnoreCase)) throw new Failure("invalid");
        if (operation == "write") { Write(owner, lease, name, Text(request, "dataBase64"), Bound(request), Flag(request, "initialize")); return result; }
        if (operation == "clean-partial") name += ".partial";
        try
        {
            uint access = operation == "remove" || operation == "clean-partial" ? ReadFileAccess | 0x10000U : ReadFileAccess;
            using (SafeFileHandle file = Open(lease.Path.Last, name, access, 1, false, null, 1))
            {
                CheckObject(file, false); CheckAcl(file, true, owner.Sid);
                if (operation == "exists") result["exists"] = true;
                else if (operation == "read") result["dataBase64"] = ReadEncoded(file, name, Bound(request), true);
                else
                {
                    byte[] bytes = ReadBytes(file, Bound(request) + 4096);
                    Array.Clear(bytes, 0, bytes.Length);
                    Delete(file);
                }
            }
        }
        catch (Failure error)
        {
            if (error.Code != "not-found" || (operation != "exists" && operation != "clean-partial")) throw;
            if (operation == "exists") result["exists"] = false;
        }
        return result;
    }

    private static void Write(Owner owner, Lease lease, string name, string encoded, int maximum, bool initialize)
    {
        byte[] bytes = Decode(encoded, maximum);
        byte[] stored = bytes;
        SafeFileHandle output = null;
        bool published = false;
        try
        {
            if (IsKey(name))
            {
                byte[] cipher = ProtectedData.Protect(bytes, KeyEntropy, DataProtectionScope.CurrentUser);
                stored = new byte[KeyHeader.Length + cipher.Length];
                Buffer.BlockCopy(KeyHeader, 0, stored, 0, KeyHeader.Length);
                Buffer.BlockCopy(cipher, 0, stored, KeyHeader.Length, cipher.Length);
                Array.Clear(cipher, 0, cipher.Length);
            }
            if (!initialize)
            {
                using (SafeFileHandle existing = Open(lease.Path.Last, name, ReadFileAccess, 1, false, null, 1))
                {
                    CheckObject(existing, false); CheckAcl(existing, true, owner.Sid);
                    byte[] previous = ReadBytes(existing, maximum + 4096); Array.Clear(previous, 0, previous.Length);
                }
            }
            output = Open(lease.Path.Last, name + ".partial", WriteFileAccess, 2, false, Descriptor(owner.Sid), 0);
            CheckObject(output, false); CheckAcl(output, true, owner.Sid);
            uint written;
            if (!Native.WriteFile(output, stored, checked((uint)stored.Length), out written, IntPtr.Zero) || written != stored.Length || !Native.FlushFileBuffers(output)) throw LastError();
            Rename(output, lease.Path.Last, name, !initialize);
            published = true;
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
            if (!Object.ReferenceEquals(stored, bytes)) Array.Clear(stored, 0, stored.Length);
            if (output != null) { try { if (!published) Delete(output); } finally { output.Dispose(); } }
        }
    }

    private static string ReadEncoded(SafeFileHandle file, string name, int maximum, bool decrypt)
    {
        byte[] bytes = ReadBytes(file, maximum + (IsKey(name) ? 4096 : 0));
        byte[] plain = bytes;
        try
        {
            if (decrypt && IsKey(name))
            {
                if (bytes.Length <= KeyHeader.Length) throw new Failure("untrusted");
                for (int i = 0; i < KeyHeader.Length; i++) if (bytes[i] != KeyHeader[i]) throw new Failure("untrusted");
                byte[] cipher = new byte[bytes.Length - KeyHeader.Length];
                Buffer.BlockCopy(bytes, KeyHeader.Length, cipher, 0, cipher.Length);
                try { plain = ProtectedData.Unprotect(cipher, KeyEntropy, DataProtectionScope.CurrentUser); }
                catch { throw new Failure("untrusted"); }
                finally { Array.Clear(cipher, 0, cipher.Length); }
            }
            if (plain.Length > maximum) throw new Failure("limit");
            return Convert.ToBase64String(plain);
        }
        finally { Array.Clear(bytes, 0, bytes.Length); if (!Object.ReferenceEquals(bytes, plain)) Array.Clear(plain, 0, plain.Length); }
    }

    private static byte[] ReadBytes(SafeFileHandle file, int maximum)
    {
        byte[] information = Information(file, 1, 24);
        long length = BitConverter.ToInt64(information, 8);
        if (length < 0 || length > maximum) throw new Failure("limit");
        byte[] bytes = new byte[checked((int)length)];
        int offset = 0;
        try
        {
            while (offset < bytes.Length)
            {
                byte[] part = new byte[Math.Min(65536, bytes.Length - offset)];
                uint read;
                try
                {
                    if (!Native.ReadFile(file, part, (uint)part.Length, out read, IntPtr.Zero) || read == 0) throw LastError();
                    Buffer.BlockCopy(part, 0, bytes, offset, checked((int)read)); offset += checked((int)read);
                }
                finally { Array.Clear(part, 0, part.Length); }
            }
            if (BitConverter.ToInt64(Information(file, 1, 24), 8) != length) throw new Failure("untrusted");
            return bytes;
        }
        catch { Array.Clear(bytes, 0, bytes.Length); throw; }
    }

    private static PinnedPath OpenPath(Owner owner, string path, bool privateTarget, bool create)
    {
        path = Canonical(path);
        PinnedPath held = new PinnedPath();
        try
        {
            string root = path.Substring(0, 3);
            SafeFileHandle volume = Open(null, owner.NativeRoot(path), ReadDirectory, 1, true, null, 3);
            held.Handles.Add(volume); CheckObject(volume, true); CheckAcl(volume, false, owner.Sid, true);
            string current = root.TrimEnd(new char[] { '\\' });
            string[] parts = path.Length == 3 ? new string[0] : path.Substring(3).Split(new char[] { '\\' });
            for (int i = 0; i < parts.Length; i++)
            {
                current += "\\" + parts[i];
                bool managed = Inside(current, owner.Root);
                bool creatable = managed || String.Equals(current, owner.Base + "\\Nerva", StringComparison.OrdinalIgnoreCase);
                SafeFileHandle next = Open(held.Last, parts[i], ReadDirectory, create && creatable ? 3U : 1U, true, create && creatable ? Descriptor(owner.Sid) : null, 3);
                held.Handles.Add(next); CheckObject(next, true);
                CheckAcl(next, managed || (privateTarget && i == parts.Length - 1), owner.Sid, !String.Equals(current, owner.Base, StringComparison.OrdinalIgnoreCase));
            }
            return held;
        }
        catch { held.Dispose(); throw; }
    }

    private static SafeFileHandle Open(SafeFileHandle parent, string name, uint access, uint disposition, bool directory, byte[] descriptor, uint share, uint extraOptions = 0)
    {
        if (parent != null) ValidateLeaf(name);
        IntPtr nameBuffer = Marshal.StringToHGlobalUni(name);
        IntPtr unicodeBuffer = IntPtr.Zero;
        GCHandle security = new GCHandle();
        try
        {
            Native.UNICODE_STRING unicode = new Native.UNICODE_STRING { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)(name.Length * 2)), Buffer = nameBuffer };
            unicodeBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.UNICODE_STRING))); Marshal.StructureToPtr(unicode, unicodeBuffer, false);
            if (descriptor != null) security = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
            Native.OBJECT_ATTRIBUTES attributes = new Native.OBJECT_ATTRIBUTES { Length = Marshal.SizeOf(typeof(Native.OBJECT_ATTRIBUTES)), RootDirectory = parent == null ? IntPtr.Zero : parent.DangerousGetHandle(), ObjectName = unicodeBuffer, Attributes = 0x1040, SecurityDescriptor = descriptor == null ? IntPtr.Zero : security.AddrOfPinnedObject() };
            Native.IO_STATUS_BLOCK result;
            SafeFileHandle handle;
            int status = Native.NtCreateFile(out handle, access, ref attributes, out result, IntPtr.Zero, directory ? 0x10U : 0x80U, share, disposition, 0x200020U | (directory ? 1U : 0x40U) | extraOptions, IntPtr.Zero, 0);
            GC.KeepAlive(parent);
            if (status < 0) { if (handle != null) handle.Dispose(); throw Status(status); }
            return handle;
        }
        finally { if (security.IsAllocated) security.Free(); if (unicodeBuffer != IntPtr.Zero) Marshal.FreeHGlobal(unicodeBuffer); Marshal.FreeHGlobal(nameBuffer); }
    }

    private static byte[] Descriptor(string sid)
    {
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor("O:" + sid + "G:SYD:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)");
        byte[] bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0); return bytes;
    }

    /// <summary>Pure validation permits only the current owner and SYSTEM on private state; never repairs an existing ACL.</summary>
    public static void ValidateDescriptor(RawSecurityDescriptor descriptor, bool secret, string expectedSid)
    {
        ValidateDescriptorCore(descriptor, secret, expectedSid, false);
    }

    /// <summary>Pinned ancestors may grant child creation, but never foreign replacement or ACL authority.</summary>
    public static void ValidateDirectoryDescriptor(RawSecurityDescriptor descriptor, bool secret, string expectedSid)
    {
        ValidateDescriptorCore(descriptor, secret, expectedSid, true);
    }

    private static void ValidateDescriptorCore(RawSecurityDescriptor descriptor, bool secret, string expectedSid, bool ancestor)
    {
        if (descriptor == null || descriptor.Owner == null || descriptor.DiscretionaryAcl == null) throw new Failure("untrusted");
        string owner = descriptor.Owner.Value;
        if (secret ? owner != expectedSid : !Trusted(owner, expectedSid)) throw new Failure("untrusted");
        if (secret && (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0) throw new Failure("untrusted");
        bool user = false; bool system = false;
        foreach (GenericAce entry in descriptor.DiscretionaryAcl)
        {
            CommonAce ace = entry as CommonAce;
            if ((entry.AceFlags & AceFlags.InheritOnly) != 0) { if (secret) throw new Failure("untrusted"); continue; }
            if (ace == null || ace.IsCallback) throw new Failure("untrusted");
            string sid = ace.SecurityIdentifier.Value;
            if (ace.AceQualifier != AceQualifier.AccessAllowed) { if (secret) throw new Failure("untrusted"); continue; }
            if (secret)
            {
                if ((ace.AceFlags & AceFlags.Inherited) != 0 || (sid != expectedSid && sid != "S-1-5-18")) throw new Failure("untrusted");
                if (sid == expectedSid) user = true; if (sid == "S-1-5-18") system = true;
            }
            else if (!Trusted(sid, expectedSid) && !Sandboxed(sid) && (ace.AccessMask & unchecked((int)(ancestor ? 0x500D0150 : 0x500D0156))) != 0) throw new Failure("untrusted");
        }
        if (secret && (!user || !system)) throw new Failure("untrusted");
    }

    /// <summary>
    /// AppContainer (S-1-15-2-*) and capability (S-1-15-3-*) SIDs on a folder that holds no secret never name another account.
    /// </summary>
    /// <remarks>
    /// Windows evaluates them only for this user's own sandboxed apps, and grants such an app access only when the user's
    /// own entry allows it too, so they give no process more than this user's ordinary programs already have. Some PCs
    /// grant ALL APPLICATION PACKAGES or one app's package change rights on AppData\Local or AppData\Local\Nerva, which made
    /// the connector refuse to start there. The private Nerva\Connector folder and its files still allow only this user and
    /// SYSTEM.
    /// </remarks>
    private static bool Sandboxed(string sid)
    {
        return sid.StartsWith("S-1-15-2-", StringComparison.Ordinal) || sid.StartsWith("S-1-15-3-", StringComparison.Ordinal);
    }

    private static bool Trusted(string sid, string user)
    {
        return sid == user || sid == "S-1-5-18" || sid == "S-1-5-32-544" || sid == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    }

    private static void CheckAcl(SafeFileHandle handle, bool secret, string sid, bool ancestor = false)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint status = Native.GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
        if (status != 0) throw new Failure("untrusted");
        try
        {
            uint length = Native.GetSecurityDescriptorLength(descriptor);
            if (length == 0 || length > 65536) throw new Failure("untrusted");
            byte[] bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, checked((int)length));
            ValidateDescriptorCore(new RawSecurityDescriptor(bytes, 0), secret, sid, ancestor);
        }
        finally { Native.LocalFree(descriptor); }
    }

    private static void CheckObject(SafeFileHandle handle, bool directory)
    {
        byte[] attributes = Information(handle, 9, 8);
        uint flags = BitConverter.ToUInt32(attributes, 0);
        byte[] standard = Information(handle, 1, 24);
        if ((flags & 0x400) != 0 || ((flags & 0x10) != 0) != directory || standard[20] != 0 || (!directory && BitConverter.ToUInt32(standard, 16) != 1)) throw new Failure("untrusted");
    }

    private static byte[] Information(SafeFileHandle file, int kind, int size)
    {
        byte[] bytes = new byte[size]; if (!Native.GetFileInformationByHandleEx(file, kind, bytes, (uint)size)) throw LastError(); return bytes;
    }

    private static string FileIdentity(SafeFileHandle directory) { return Convert.ToBase64String(Information(directory, 18, 24)); }
    private static string LockName(string purpose, string identity)
    {
        using (SHA256 digest = SHA256.Create()) { return ".nexa-lock-" + purpose + "-" + BitConverter.ToString(digest.ComputeHash(Encoding.UTF8.GetBytes(purpose + ":" + identity))).Replace("-", "").ToLowerInvariant(); }
    }

    private static void Rename(SafeFileHandle file, SafeFileHandle directory, string name, bool replace)
    {
        byte[] encoded = Encoding.Unicode.GetBytes(name);
        int rootOffset = IntPtr.Size == 8 ? 8 : 4;
        int lengthOffset = rootOffset + IntPtr.Size;
        int nameOffset = lengthOffset + 4;
        int size = Math.Max(IntPtr.Size == 8 ? 24 : 16, nameOffset + encoded.Length + 2);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
            Marshal.WriteByte(buffer, 0, replace ? (byte)1 : (byte)0);
            Marshal.WriteIntPtr(buffer, rootOffset, directory.DangerousGetHandle());
            Marshal.WriteInt32(buffer, lengthOffset, encoded.Length); Marshal.Copy(encoded, 0, IntPtr.Add(buffer, nameOffset), encoded.Length);
            Native.IO_STATUS_BLOCK result;
            int status = Native.NtSetInformationFile(file, out result, buffer, (uint)size, 10);
            GC.KeepAlive(directory); if (status < 0) throw Status(status);
            if (!Native.FlushFileBuffers(file)) throw LastError();
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void Delete(SafeFileHandle file)
    {
        IntPtr buffer = Marshal.AllocHGlobal(1);
        try { Marshal.WriteByte(buffer, 1); Native.IO_STATUS_BLOCK result; int status = Native.NtSetInformationFile(file, out result, buffer, 1, 13); if (status < 0) throw Status(status); }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static string[] List(SafeFileHandle directory, string identity)
    {
        List<string> names = new List<string>();
        byte[] buffer = new byte[8192]; bool restart = true;
        while (true)
        {
            Native.IO_STATUS_BLOCK result;
            int status = Native.NtQueryDirectoryFile(directory, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out result, buffer, (uint)buffer.Length, 12, false, IntPtr.Zero, restart);
            restart = false;
            if (status == unchecked((int)0x80000006)) break;
            if (status < 0) throw Status(status);
            int available = checked((int)result.Information.ToUInt64());
            if (available < 12 || available > buffer.Length) throw new Failure("io");
            int offset = 0;
            while (true)
            {
                if (offset < 0 || offset + 12 > available) throw new Failure("io");
                int next = BitConverter.ToInt32(buffer, offset); int length = BitConverter.ToInt32(buffer, offset + 8);
                if (length < 0 || (length & 1) != 0 || offset + 12 + length > available) throw new Failure("io");
                string name = Encoding.Unicode.GetString(buffer, offset + 12, length);
                bool ownLock = false; foreach (string purpose in Purposes) if (name == LockName(purpose, identity)) ownLock = true;
                if (name != "." && name != ".." && !ownLock) { ValidateLeaf(name); names.Add(name); if (names.Count > 128) throw new Failure("limit"); }
                if (next == 0) break; if (next < 12 || offset + next <= offset) throw new Failure("io"); offset += next;
            }
        }
        names.Sort(StringComparer.Ordinal); return names.ToArray();
    }

    /// <summary>Names never select an alternate stream, device, traversal, ambiguous suffix or reparse path.</summary>
    public static void ValidateLeaf(string name)
    {
        if (String.IsNullOrEmpty(name) || name.Length > 255 || name == "." || name == ".." || name.EndsWith(".", StringComparison.Ordinal) || name.EndsWith(" ", StringComparison.Ordinal)) throw new Failure("invalid");
        foreach (char value in name) if (value < 32 || value == 127 || "\\/:*?\"<>|".IndexOf(value) >= 0) throw new Failure("invalid");
        if (!ValidUnicode(name) || Regex.IsMatch(name, "^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\\$|CONOUT\\$|CLOCK\\$)([ .]|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) throw new Failure("invalid");
    }

    private static string Canonical(string path)
    {
        if (path == null || path.Length < 3 || path.Length > 4096 || (Char.ToUpperInvariant(path[0]) < 'A' || Char.ToUpperInvariant(path[0]) > 'Z') || path[1] != ':' || path[2] != '\\' || path.IndexOf('/') >= 0 || !String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase)) throw new Failure("invalid");
        if (path.Length > 3) foreach (string name in path.Substring(3).Split(new char[] { '\\' })) ValidateLeaf(name);
        return path;
    }

    private static bool Inside(string path, string root) { return String.Equals(path, root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase); }

    /// <summary>Only a direct kernel disk-volume device can anchor state; SUBST, UNC and namespace aliases are refused.</summary>
    public static string ValidateVolumeTarget(string mapping)
    {
        if (mapping == null || mapping.Length > 128 || !Regex.IsMatch(mapping, @"\A\\Device\\HarddiskVolume[0-9]+\z", RegexOptions.CultureInvariant)) throw new Failure("untrusted");
        return mapping + "\\";
    }

    private static string QueryVolume(string drive)
    {
        char[] buffer = new char[4096];
        uint count = Native.QueryDosDeviceW(drive, buffer, (uint)buffer.Length);
        if (count == 0) throw LastError();
        if (count > buffer.Length || buffer[count - 1] != '\0') throw new Failure("untrusted");
        int end = Array.IndexOf(buffer, '\0');
        if (end <= 0 || end >= count) throw new Failure("untrusted");
        return ValidateVolumeTarget(new string(buffer, 0, end));
    }
    private static bool IsKey(string name) { return String.Equals(name, "device-key.json", StringComparison.OrdinalIgnoreCase) || String.Equals(name, "device-key.json.partial", StringComparison.OrdinalIgnoreCase); }
    private static Lease GetLease(Owner owner, string token) { Lease lease; if (!owner.Leases.TryGetValue(token, out lease)) throw new Failure("invalid"); return lease; }
    private static string RandomToken() { byte[] bytes = new byte[24]; using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(bytes); return Convert.ToBase64String(bytes); }
    private static string Text(Dictionary<string, object> request, string key) { string value = request[key] as string; if (value == null) throw new Failure("invalid"); return value; }
    private static bool Flag(Dictionary<string, object> request, string key) { if (!(request[key] is bool)) throw new Failure("invalid"); return (bool)request[key]; }
    private static int Bound(Dictionary<string, object> request) { if (!(request["maximumBytes"] is int)) throw new Failure("invalid"); int bound = (int)request["maximumBytes"]; if (bound < 1 || bound > 1048576) throw new Failure("limit"); return bound; }
    private static byte[] Decode(string text, int maximum) { if (text.Length > 4 * ((maximum + 2) / 3)) throw new Failure("limit"); byte[] bytes; try { bytes = Convert.FromBase64String(text); } catch { throw new Failure("invalid"); } if (bytes.Length > maximum || Convert.ToBase64String(bytes) != text) { Array.Clear(bytes, 0, bytes.Length); throw new Failure("invalid"); } return bytes; }
    private static void Fields(Dictionary<string, object> request, params string[] allowed) { foreach (string key in RequestFields) if (key != "id" && key != "operation" && Array.IndexOf(allowed, key) < 0 && request[key] != null) throw new Failure("invalid"); }
    private static bool ValidUnicode(string text) { for (int i = 0; i < text.Length; i++) if (Char.IsSurrogate(text[i])) { if (!Char.IsHighSurrogate(text[i]) || i + 1 >= text.Length || !Char.IsLowSurrogate(text[++i])) return false; } return true; }

    private static string ReadLine()
    {
        StringBuilder line = new StringBuilder();
        while (true) { int value = Console.In.Read(); if (value < 0) { if (line.Length != 0) throw new Failure("invalid"); return null; } if (value == 10) return line.ToString(); if (line.Length >= MaximumLine) throw new Failure("limit"); line.Append((char)value); }
    }

    private static Dictionary<string, object> Parse(string line)
    {
        Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal); int index = 0;
        Space(line, ref index); Take(line, ref index, '{'); Space(line, ref index);
        while (index < line.Length && line[index] != '}')
        {
            string key = JsonString(line, ref index); Space(line, ref index); Take(line, ref index, ':'); Space(line, ref index);
            if (Array.IndexOf(RequestFields, key) < 0 || result.ContainsKey(key)) throw new Failure("invalid");
            object value;
            if (index < line.Length && line[index] == '"') value = JsonString(line, ref index);
            else { int begin = index; while (index < line.Length && line[index] != ',' && line[index] != '}' && !Char.IsWhiteSpace(line[index])) index++; string token = line.Substring(begin, index - begin); int integer; if (token == "null") value = null; else if (token == "true") value = true; else if (token == "false") value = false; else if (Regex.IsMatch(token, "^(0|[1-9][0-9]{0,8})$") && Int32.TryParse(token, NumberStyles.None, CultureInfo.InvariantCulture, out integer)) value = integer; else throw new Failure("invalid"); }
            result.Add(key, value); Space(line, ref index);
            if (index < line.Length && line[index] == '}') break;
            Take(line, ref index, ','); Space(line, ref index); if (index < line.Length && line[index] == '}') throw new Failure("invalid");
        }
        Take(line, ref index, '}'); Space(line, ref index); if (index != line.Length || result.Count != RequestFields.Length) throw new Failure("invalid"); return result;
    }

    private static string JsonString(string line, ref int index)
    {
        int begin = index; Take(line, ref index, '"');
        while (index < line.Length)
        {
            char value = line[index++];
            if (value < 32) throw new Failure("invalid");
            if (value == '"')
            {
                string text;
                try { text = Json.Deserialize<string>(line.Substring(begin, index - begin)); }
                catch { throw new Failure("invalid"); }
                if (!ValidUnicode(text)) throw new Failure("invalid");
                return text;
            }
            if (value == '\\')
            {
                if (index >= line.Length) throw new Failure("invalid");
                char escape = line[index++];
                if (escape == 'u')
                {
                    if (index + 4 > line.Length) throw new Failure("invalid");
                    for (int i = 0; i < 4; i++) if (!Uri.IsHexDigit(line[index++])) throw new Failure("invalid");
                }
                else if ("\"\\/bfnrt".IndexOf(escape) < 0) throw new Failure("invalid");
            }
        }
        throw new Failure("invalid");
    }

    private static void Space(string line, ref int index) { while (index < line.Length && (line[index] == ' ' || line[index] == '\t' || line[index] == '\r')) index++; }
    private static void Take(string line, ref int index, char value) { if (index >= line.Length || line[index++] != value) throw new Failure("invalid"); }
    private static void WriteReply(string id, bool ok, Dictionary<string, object> values, string error)
    {
        Dictionary<string, object> result = new Dictionary<string, object> { { "id", id }, { "ok", ok }, { "path", null }, { "lease", null }, { "exists", null }, { "names", null }, { "dataBase64", null }, { "error", error }, { "sizeBytes", null }, { "sha256", null } };
        if (values != null) foreach (KeyValuePair<string, object> item in values) result[item.Key] = item.Value;
        Console.Out.WriteLine(Json.Serialize(result)); Console.Out.Flush();
    }

    private static Failure LastError() { int code = Marshal.GetLastWin32Error(); return new Failure(code == 2 || code == 3 ? "not-found" : code == 32 || code == 33 ? "busy" : code == 80 || code == 183 ? "exists" : code == 5 ? "untrusted" : "io"); }
    private static Failure Status(int status) { return new Failure(status == unchecked((int)0xC0000034) || status == unchecked((int)0xC000003A) ? "not-found" : status == unchecked((int)0xC0000035) ? "exists" : status == unchecked((int)0xC0000043) || status == unchecked((int)0xC0000054) ? "busy" : status == unchecked((int)0xC0000022) || status == unchecked((int)0xC000050B) || status == unchecked((int)0xC0000279) ? "untrusted" : "io"); }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)] internal struct UNICODE_STRING { internal ushort Length; internal ushort MaximumLength; internal IntPtr Buffer; }
        [StructLayout(LayoutKind.Sequential)] internal struct OBJECT_ATTRIBUTES { internal int Length; internal IntPtr RootDirectory; internal IntPtr ObjectName; internal uint Attributes; internal IntPtr SecurityDescriptor; internal IntPtr SecurityQualityOfService; }
        [StructLayout(LayoutKind.Sequential)] internal struct IO_STATUS_BLOCK { internal IntPtr Status; internal UIntPtr Information; }
        [StructLayout(LayoutKind.Sequential)] internal struct OVERLAPPED { internal IntPtr Internal; internal IntPtr InternalHigh; internal uint Offset; internal uint OffsetHigh; internal IntPtr Event; }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] internal static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] internal static extern uint QueryDosDeviceW(string name, [Out] char[] path, uint length);
        [DllImport("ntdll.dll")] internal static extern int NtCreateFile(out SafeFileHandle file, uint access, ref OBJECT_ATTRIBUTES attributes, out IO_STATUS_BLOCK result, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
        [DllImport("ntdll.dll")] internal static extern int NtSetInformationFile(SafeFileHandle file, out IO_STATUS_BLOCK result, IntPtr information, uint length, int kind);
        [DllImport("ntdll.dll")] internal static extern int NtQueryDirectoryFile(SafeFileHandle file, IntPtr action, IntPtr apc, IntPtr context, out IO_STATUS_BLOCK result, [Out] byte[] information, uint length, int kind, [MarshalAs(UnmanagedType.U1)] bool single, IntPtr name, [MarshalAs(UnmanagedType.U1)] bool restart);
        [DllImport("advapi32.dll")] internal static extern uint GetSecurityInfo(SafeFileHandle file, int kind, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll")] internal static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
        [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, [Out] byte[] information, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ReadFile(SafeFileHandle file, [Out] byte[] bytes, uint count, out uint read, IntPtr overlap);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool WriteFile(SafeFileHandle file, byte[] bytes, uint count, out uint written, IntPtr overlap);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool FlushFileBuffers(SafeFileHandle file);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool LockFileEx(SafeFileHandle file, uint flags, uint reserved, uint low, uint high, ref OVERLAPPED overlap);
    }
}
