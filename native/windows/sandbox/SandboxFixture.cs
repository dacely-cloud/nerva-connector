// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

/// <summary>One serialized owned canary slot. A crash leaves bounded intent, never an unlimited collection of profiles.</summary>
internal sealed class SandboxFixture : IDisposable
{
    internal readonly string Sid;
    internal readonly string Root;
    internal readonly string Nonce;
    internal string ProfileName;
    internal string PackageSid;
    internal string ProfilePath;
    internal string PackageRoot;
    internal IntPtr Package;
    internal SafeFileHandle Allowed, Excluded;
    private SandboxPath path;
    private SafeFileHandle purposeLock, intent, blocked;
    private bool createdProfile;

    internal SandboxFixture()
    {
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            if (identity.User == null || identity.IsAnonymous) throw new InvalidOperationException("owner");
            Sid = identity.User.Value;
        }
        Root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + "\\Nerva\\Connector\\qualification";
        Nonce = NewNonce();
        try
        {
            path = new SandboxPath(Root, Sid, false, Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + "\\Nerva", null);
            purposeLock = SandboxPath.Open(path.Last, "purpose.lock", false, 0xC0130000, 3, 3, SandboxPath.Private(Sid));
            SandboxPath.Validate(purposeLock, false, Sid, true, null);
            SandboxNative.Overlapped overlap = new SandboxNative.Overlapped();
            if (!SandboxNative.LockFileEx(purposeLock, 3, 0, 1, 0, ref overlap)) throw new InvalidOperationException("busy");
            Reconcile();
            intent = Create("profile.intent");
            SandboxPath.Write(intent, Encoding.ASCII.GetBytes("P" + Nonce));
            ProfileName = SandboxPolicy.Profile(Nonce);
            if (SandboxNative.CreateAppContainerProfile(ProfileName, "Nexa connector confinement qualification", "Owned disposable native confinement canary", IntPtr.Zero, 0, out Package) != 0) throw new InvalidOperationException("profile-create");
            createdProfile = true;
            PackageSid = new SecurityIdentifier(Package).Value;
            long position;
            if (!SandboxNative.SetFilePointerEx(intent, 0, out position, 0) || position != 0) throw new InvalidOperationException("intent-position");
            SandboxPath.Write(intent, Encoding.ASCII.GetBytes("O" + Nonce));
            IntPtr folder;
            if (SandboxNative.GetAppContainerFolderPath(PackageSid, out folder) != 0) throw new InvalidOperationException("profile-path");
            try { ProfilePath = Marshal.PtrToStringUni(folder); }
            finally { Marshal.FreeCoTaskMem(folder); }
            PackageRoot = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + "\\Packages\\" + ProfileName;
            if (ProfilePath == null || !ProfilePath.StartsWith(PackageRoot + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("profile-path");
            Allowed = Create("allowed.bin"); SandboxPath.Write(Allowed, Encoding.ASCII.GetBytes(Nonce));
            blocked = Create("blocked.bin"); SandboxPath.Write(blocked, Encoding.ASCII.GetBytes(Nonce));
            Excluded = Create("excluded.bin"); SandboxPath.Write(Excluded, Encoding.ASCII.GetBytes(Nonce));
        }
        catch { Dispose(); throw; }
    }

    private static string NewNonce()
    {
        byte[] bytes = new byte[16];
        using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) generator.GetBytes(bytes);
        return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    }

    private SafeFileHandle Create(string name)
    {
        SafeFileHandle file = SandboxPath.Open(path.Last, name, false, 0xC0130000, 2, 3, SandboxPath.Private(Sid));
        try { SandboxPath.Validate(file, false, Sid, true, null); return file; }
        catch { file.Dispose(); throw; }
    }

    private void Reconcile()
    {
        SafeFileHandle previous;
        try { previous = SandboxPath.Open(path.Last, "profile.intent", false, 0x80130000, 1, 3, null); }
        catch (FileNotFoundException) { return; }
        using (previous)
        {
            SandboxPath.Validate(previous, false, Sid, true, null);
            string value = Encoding.ASCII.GetString(SandboxPath.Read(previous, 33));
            if (value.Length != 33 || value[0] != 'O') throw new InvalidOperationException("unconfirmed-profile-intent");
            string profile = SandboxPolicy.Profile(value.Substring(1));
            if (SandboxNative.DeleteAppContainerProfile(profile) != 0) throw new InvalidOperationException("profile-cleanup");
            foreach (string name in new string[] { "allowed.bin", "blocked.bin", "excluded.bin" })
            {
                SafeFileHandle stale;
                try { stale = SandboxPath.Open(path.Last, name, false, 0x80130000, 1, 3, null); }
                catch (FileNotFoundException) { continue; }
                using (stale) { SandboxPath.Validate(stale, false, Sid, true, null); SandboxPath.Delete(stale); }
            }
            SandboxPath.Delete(previous);
        }
    }

    internal SandboxPath PublishWorker(byte[] bytes)
    {
        using (SandboxPath directory = new SandboxPath(ProfilePath, Sid, false, null, PackageSid, PackageRoot))
        {
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor("O:" + Sid + "G:SYD:P(A;;FA;;;" + Sid + ")(A;;FA;;;SY)(A;;FRFX;;;" + PackageSid + ")");
            byte[] security = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(security, 0);
            using (SafeFileHandle file = SandboxPath.Open(directory.Last, SandboxPolicy.WorkerName, false, 0xC0130000, 2, 1, security))
            {
                SandboxPath.Validate(file, false, Sid, false, PackageSid);
                SandboxPath.Write(file, bytes);
            }
        }
        return new SandboxPath(ProfilePath + "\\" + SandboxPolicy.WorkerName, Sid, true, null, PackageSid, PackageRoot);
    }

    internal void VerifyCanaries()
    {
        foreach (SafeFileHandle file in new SafeFileHandle[] { Allowed, blocked, Excluded })
        {
            long position;
            if (!SandboxNative.SetFilePointerEx(file, 0, out position, 0) || position != 0 || Encoding.ASCII.GetString(SandboxPath.Read(file, 32)) != Nonce) throw new InvalidOperationException("canary-changed");
        }
    }

    public void Dispose()
    {
        bool clean = true;
        foreach (SafeFileHandle file in new SafeFileHandle[] { Allowed, blocked, Excluded })
        {
            if (file == null) continue;
            try { SandboxPath.Delete(file); } catch { clean = false; }
            file.Dispose();
        }
        Allowed = null; blocked = null; Excluded = null;
        if (Package != IntPtr.Zero) { SandboxNative.FreeSid(Package); Package = IntPtr.Zero; }
        if (createdProfile)
        {
            if (SandboxNative.DeleteAppContainerProfile(ProfileName) != 0) clean = false;
            else createdProfile = false;
        }
        if (intent != null)
        {
            if (clean) { try { SandboxPath.Delete(intent); } catch { clean = false; } }
            intent.Dispose(); intent = null;
        }
        if (purposeLock != null) { purposeLock.Dispose(); purposeLock = null; }
        if (path != null) { path.Dispose(); path = null; }
        if (!clean) throw new InvalidOperationException("qualification-cleanup");
    }
}
