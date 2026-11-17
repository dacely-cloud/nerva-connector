// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

/// <summary>The broker verifies the suspended child's kernel token instead of trusting its report.</summary>
internal static class SandboxToken
{
    internal static void Verify(IntPtr process, string packageSid)
    {
        SafeFileHandle token;
        if (!SandboxNative.OpenProcessToken(process, 8, out token))
        {
            throw new InvalidOperationException("token-open");
        }
        using (token)
        {
            IntPtr memory = Marshal.AllocHGlobal(4096);
            try
            {
                if (
                    Number(token, SandboxTokenField.IsAppContainer, memory) != 1
                    || Number(token, SandboxTokenField.IsLpac, memory) != 1
                    || Number(token, SandboxTokenField.Capabilities, memory) != 0
                    || Number(token, SandboxTokenField.Elevation, memory) != 0
                )
                {
                    throw new InvalidOperationException("token-policy");
                }
                uint returned;
                if (
                    !SandboxNative.GetTokenInformation(
                        token,
                        SandboxTokenField.PackageSid,
                        memory,
                        4096,
                        out returned
                    )
                    || returned < IntPtr.Size
                    || returned > 4096
                )
                {
                    throw new InvalidOperationException("token-sid");
                }
                IntPtr sid = Marshal.ReadIntPtr(memory);
                long offset = sid.ToInt64() - memory.ToInt64();
                if (
                    offset < IntPtr.Size
                    || offset > returned - 8
                    || offset + 8 + Marshal.ReadByte(sid, 1) * 4 > returned
                    || !String.Equals(
                        new SecurityIdentifier(sid).Value,
                        packageSid,
                        StringComparison.Ordinal
                    )
                )
                {
                    throw new InvalidOperationException("token-sid");
                }
                uint childPolicy;
                if (
                    !SandboxNative.GetProcessMitigationPolicy(
                        process,
                        SandboxMitigation.ChildProcesses,
                        out childPolicy,
                        new UIntPtr(4)
                    )
                    || (childPolicy & 1) != 1
                )
                {
                    throw new InvalidOperationException("child-policy");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(memory);
            }
        }
    }

    private static uint Number(SafeFileHandle token, SandboxTokenField kind, IntPtr memory)
    {
        uint returned;
        if (
            !SandboxNative.GetTokenInformation(token, kind, memory, 4096, out returned)
            || returned < 4
            || returned > 4096
        )
        {
            throw new InvalidOperationException("token-query");
        }
        return unchecked((uint)Marshal.ReadInt32(memory));
    }
}
