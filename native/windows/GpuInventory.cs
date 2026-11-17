// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;

/// <summary>Read-only DXGI adapter enumeration uses the installed Windows display drivers, without scripts or a shell.</summary>
public static class NexaConnectorGpuInventory
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct Description
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] internal string Name;
        internal uint VendorId;
        internal uint DeviceId;
        internal uint SubsystemId;
        internal uint Revision;
        internal UIntPtr DedicatedVideoMemory;
        internal UIntPtr DedicatedSystemMemory;
        internal UIntPtr SharedSystemMemory;
        internal uint LuidLow;
        internal int LuidHigh;
        internal uint Flags;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int EnumerateAdapter(IntPtr factory, uint index, out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int DescribeAdapter(IntPtr adapter, out Description description);

    [DllImport("dxgi.dll", ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    private static extern int CreateDXGIFactory1(ref Guid identity, out IntPtr factory);

    /// <summary>Every COM reference is released, including failed descriptors and unsupported software adapters.</summary>
    public static List<Dictionary<string, object>> Read()
    {
        Guid identity = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        IntPtr factory;
        int result = CreateDXGIFactory1(ref identity, out factory);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        if (factory == IntPtr.Zero) throw new InvalidOperationException("DXGI factory unavailable");
        try { return Enumerate(factory); }
        finally { Marshal.Release(factory); }
    }

    internal static List<Dictionary<string, object>> Enumerate(IntPtr factory)
    {
        IntPtr table = Marshal.ReadIntPtr(factory);
        EnumerateAdapter enumerate = (EnumerateAdapter)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(table, 12 * IntPtr.Size), typeof(EnumerateAdapter));
        List<Dictionary<string, object>> devices = new List<Dictionary<string, object>>();
        HashSet<string> identities = new HashSet<string>(StringComparer.Ordinal);
        for (uint index = 0; index <= 32; index++)
        {
            IntPtr adapter;
            int result = enumerate(factory, index, out adapter);
            if (result == unchecked((int)0x887A0002)) return devices;
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            if (adapter == IntPtr.Zero) throw new InvalidOperationException("DXGI adapter unavailable");
            try
            {
                if (index == 32) throw new InvalidOperationException("GPU inventory limit exceeded");
                IntPtr adapterTable = Marshal.ReadIntPtr(adapter);
                DescribeAdapter describe = (DescribeAdapter)Marshal.GetDelegateForFunctionPointer(
                    Marshal.ReadIntPtr(adapterTable, 10 * IntPtr.Size), typeof(DescribeAdapter));
                Description description;
                result = describe(adapter, out description);
                if (result < 0) Marshal.ThrowExceptionForHR(result);
                if ((description.Flags & 3) != 0) continue;
                Dictionary<string, object> device = Device(description);
                if (!identities.Add((string)device["id"])) throw new InvalidOperationException("Duplicate DXGI adapter");
                devices.Add(device);
            }
            finally { Marshal.Release(adapter); }
        }
        throw new InvalidOperationException("GPU inventory limit exceeded");
    }

    internal static Dictionary<string, object> Device(Description description)
    {
        string name = description.Name == null ? "" : description.Name.Trim();
        if (name.Length == 0 || name.Length > 256) throw new InvalidOperationException("Invalid GPU name");
        foreach (char value in name) if (char.IsControl(value)) throw new InvalidOperationException("Invalid GPU name");
        string vendor = description.VendorId == 0x10DE ? "nvidia" :
            description.VendorId == 0x1002 ? "amd" : description.VendorId == 0x8086 ? "intel" : "other";
        return new Dictionary<string, object> {
            { "id", "DXGI-" + unchecked((uint)description.LuidHigh).ToString("X8", CultureInfo.InvariantCulture) + "-" + description.LuidLow.ToString("X8", CultureInfo.InvariantCulture) },
            { "vendor", vendor },
            { "model", name },
            { "totalVramBytes", description.DedicatedVideoMemory.ToUInt64().ToString(CultureInfo.InvariantCulture) },
            { "availableVramBytes", null }
        };
    }
}
