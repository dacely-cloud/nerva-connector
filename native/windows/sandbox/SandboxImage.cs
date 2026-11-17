// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using Microsoft.Win32.SafeHandles;

/// <summary>The suspended process must actually map the originally pinned physical image before its first thread is resumed.</summary>
internal static class SandboxImage
{
    private const uint NativeVolumeName = 2;
    private const uint NativeProcessName = 1;

    internal static SandboxImageIdentity Capture(SafeFileHandle file)
    {
        byte[] attributes = SandboxPath.Information(file, SandboxFileInformation.AttributeTag, 8);
        byte[] standard = SandboxPath.Information(file, SandboxFileInformation.Standard, 24);
        if ((BitConverter.ToUInt32(attributes, 0) & 0x410) != 0 || standard[20] != 0 || BitConverter.ToUInt32(standard, 16) != 1) throw new InvalidOperationException("image-kind");
        char[] name = new char[4096];
        uint length = SandboxNative.GetFinalPathNameByHandleW(file, name, (uint)name.Length, NativeVolumeName);
        if (length == 0 || length >= name.Length || name[length] != '\0') throw new InvalidOperationException("image-native-name");
        return new SandboxImageIdentity(new string(name, 0, (int)length), SandboxPath.Information(file, SandboxFileInformation.Identity, 24));
    }

    internal static void Verify(IntPtr process, SandboxPath pinned, SandboxImageIdentity original)
    {
        char[] name = new char[4096];
        uint length = (uint)name.Length;
        if (!SandboxNative.QueryFullProcessImageNameW(process, NativeProcessName, name, ref length) || length == 0 || length >= name.Length || name[length] != '\0') throw new InvalidOperationException("process-image-name");
        string actualName = new string(name, 0, (int)length);
        if (!original.MatchesName(actualName)) throw new InvalidOperationException("process-image-mismatch");
        // This is a physical NT path, not another DOS-drive lookup. Original ancestors and leaf remain held without delete sharing.
        using (SafeFileHandle actual = SandboxPath.Open(null, actualName, false, 0x00120089, 1, 1, null))
        {
            if (!original.Matches(Capture(actual)) || !original.Matches(Capture(pinned.Last))) throw new InvalidOperationException("process-image-identity");
        }
        GC.KeepAlive(pinned);
    }
}
