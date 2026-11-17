// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

/// <summary>Owns the exact inherited-handle list and zero-capability LPAC process attributes through CreateProcess.</summary>
internal sealed class SandboxAttributes : IDisposable
{
    internal IntPtr List;
    private bool initialized;
    private readonly List<IntPtr> values = new List<IntPtr>();

    internal SandboxAttributes(IntPtr package, IntPtr input, IntPtr output)
    {
        try
        {
            UIntPtr size = UIntPtr.Zero;
            if (SandboxNative.InitializeProcThreadAttributeList(IntPtr.Zero, 4, 0, ref size) || Marshal.GetLastWin32Error() != 122 || size.ToUInt64() > 65536 || size == UIntPtr.Zero) throw new InvalidOperationException("attribute-size");
            List = Marshal.AllocHGlobal((int)size.ToUInt64());
            if (!SandboxNative.InitializeProcThreadAttributeList(List, 4, 0, ref size)) throw new InvalidOperationException("attributes");
            initialized = true;
            IntPtr handles = Allocate(IntPtr.Size * 2);
            Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output);
            Add(SandboxAttribute.InheritedHandles, handles, IntPtr.Size * 2);
            SandboxNative.SecurityCapabilities capabilities = new SandboxNative.SecurityCapabilities { Sid = package, Capabilities = IntPtr.Zero, Count = 0, Reserved = 0 };
            IntPtr security = Allocate(Marshal.SizeOf(typeof(SandboxNative.SecurityCapabilities))); Marshal.StructureToPtr(capabilities, security, false);
            Add(SandboxAttribute.SecurityCapabilities, security, Marshal.SizeOf(typeof(SandboxNative.SecurityCapabilities)));
            IntPtr child = Allocate(4); Marshal.WriteInt32(child, 1); Add(SandboxAttribute.ChildProcesses, child, 4);
            IntPtr lpac = Allocate(4); Marshal.WriteInt32(lpac, 1); Add(SandboxAttribute.AllApplicationPackages, lpac, 4);
        }
        catch { Dispose(); throw; }
    }

    private IntPtr Allocate(int bytes) { IntPtr value = Marshal.AllocHGlobal(bytes); values.Add(value); return value; }
    private void Add(SandboxAttribute attribute, IntPtr value, int size)
    {
        if (!SandboxNative.UpdateProcThreadAttribute(List, 0, new IntPtr((int)attribute), value, new UIntPtr((uint)size), IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("attribute-policy");
    }

    public void Dispose()
    {
        if (List != IntPtr.Zero) { if (initialized) SandboxNative.DeleteProcThreadAttributeList(List); Marshal.FreeHGlobal(List); List = IntPtr.Zero; initialized = false; }
        foreach (IntPtr value in values) Marshal.FreeHGlobal(value);
        values.Clear();
    }
}
