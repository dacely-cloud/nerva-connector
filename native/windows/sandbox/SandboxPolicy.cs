// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

internal enum SandboxWorkerMode { Probe, Wait }
internal enum SandboxTokenField { Elevation = 20, IsAppContainer = 29, Capabilities = 30, PackageSid = 31, IsLpac = 46 }
internal enum SandboxMitigation { ChildProcesses = 13 }
internal enum SandboxAttribute { InheritedHandles = 0x20002, SecurityCapabilities = 0x20009, ChildProcesses = 0x2000e, AllApplicationPackages = 0x2000f }
internal enum SandboxFileInformation { Standard = 1, AttributeTag = 9, Identity = 18 }
internal enum SandboxJobInformation { ExtendedLimits = 9 }
internal enum SandboxWin32Error { AccessDenied = 5, ChildProcessBlocked = 367 }

/// <summary>Fixed qualification policy; this is not a general command or filesystem service.</summary>
internal static class SandboxPolicy
{
    internal const uint WallMilliseconds = 5000;
    internal const long CpuTicks = 20000000;
    internal const uint MemoryBytes = 134217728;
    internal const uint JobFlags = 0x0000270E;
    internal const uint CreationFlags = 0x08080404;
    internal const int MaximumReport = 512;
    internal const string WorkerName = "nerva-connector-file-worker.exe";
    internal const string ProfilePrefix = "nexa.qualifier.";

    /// <summary>Only documented access or child-policy denial confirms refusal; unrelated launch failures remain unconfirmed.</summary>
    internal static bool ChildCreationDenied(int code)
    {
        return code == (int)SandboxWin32Error.AccessDenied || code == (int)SandboxWin32Error.ChildProcessBlocked;
    }

    internal static string Quote(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length > 4096 || value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0) throw new ArgumentException("invalid argument");
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    internal static string Profile(string nonce)
    {
        if (nonce == null || !Regex.IsMatch(nonce, "\\A[0-9a-f]{32}\\z", RegexOptions.CultureInvariant)) throw new ArgumentException("invalid profile");
        return ProfilePrefix + nonce;
    }

    internal static IntPtr Handle(string value)
    {
        ulong number;
        if (value == null || !Regex.IsMatch(value, "\\A[1-9][0-9]{0,19}\\z", RegexOptions.CultureInvariant) || !UInt64.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out number) || number > (IntPtr.Size == 8 ? (ulong)Int64.MaxValue : (ulong)Int32.MaxValue) || number < 4) throw new ArgumentException("invalid handle");
        return new IntPtr((long)number);
    }

    internal static void Layout()
    {
        if (Marshal.SizeOf(typeof(SandboxNative.Startup)) != (IntPtr.Size == 8 ? 104 : 68) || Marshal.SizeOf(typeof(SandboxNative.StartupEx)) != (IntPtr.Size == 8 ? 112 : 72) || Marshal.SizeOf(typeof(SandboxNative.JobLimits)) != (IntPtr.Size == 8 ? 144 : 112) || Marshal.SizeOf(typeof(SandboxNative.SecurityCapabilities)) != (IntPtr.Size == 8 ? 24 : 16)) throw new InvalidOperationException("unsupported native layout");
    }
}
