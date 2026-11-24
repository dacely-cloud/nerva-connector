// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

/// <summary>Activate an installed package and identify its actual visible window, including hosted windows.</summary>
internal static class NexaConnectorPackagedApplication
{
    private static readonly Regex PackagedId = new Regex(
        @"\A[A-Za-z0-9.-]+_[A-Za-z0-9]{13}![A-Za-z0-9._-]+\z",
        RegexOptions.CultureInvariant
    );

    internal static bool IsPackagedId(string id)
    {
        return id != null && id.Length <= 130 && PackagedId.IsMatch(id);
    }

    internal static void Launch(string id)
    {
        Guid clsid = new Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c");
        Guid iid = typeof(IApplicationActivationManager).GUID;
        IApplicationActivationManager manager;
        int status = CoCreateInstance(ref clsid, IntPtr.Zero, 4, ref iid, out manager);
        if (status < 0 || manager == null)
            throw new InvalidOperationException("application-launch-rejected");
        try
        {
            uint process;
            if (manager.ActivateApplication(id, null, 0, out process) < 0 || process == 0)
                throw new InvalidOperationException("application-launch-rejected");
        }
        finally
        {
            Marshal.ReleaseComObject(manager);
        }
    }

    internal static IntPtr FindWindow(string id)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(
            delegate(IntPtr window, IntPtr unused)
            {
                if (!NexaConnectorHostApplication.Visible(window))
                    return true;
                bool matches = Matches(window, id);
                if (!matches)
                {
                    EnumChildWindows(
                        window,
                        delegate(IntPtr child, IntPtr unusedChild)
                        {
                            matches = IsWindowVisible(child) && Matches(child, id);
                            return !matches;
                        },
                        IntPtr.Zero
                    );
                }
                if (!matches)
                    return true;
                found = window;
                return false;
            },
            IntPtr.Zero
        );
        return found;
    }

    private static bool Matches(IntPtr window, string id)
    {
        uint pid;
        if (GetWindowThreadProcessId(window, out pid) == 0 || pid == 0)
            return false;
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero)
            return false;
        try
        {
            StringBuilder value = new StringBuilder(131);
            uint length = (uint)value.Capacity;
            return GetApplicationUserModelId(process, ref length, value) == 0
                && String.Equals(value.ToString(), id, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            CloseHandle(process);
        }
    }

    [
        ComImport,
        Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),
        InterfaceType(ComInterfaceType.InterfaceIsIUnknown)
    ]
    private interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string id,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint process
        );
    }

    [DllImport("ole32.dll")]
    private static extern int CoCreateInstance(
        ref Guid clsid,
        IntPtr outer,
        uint context,
        ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IApplicationActivationManager instance
    );

    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(
        IntPtr parent,
        WindowCallback callback,
        IntPtr parameter
    );

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetApplicationUserModelId(
        IntPtr process,
        ref uint length,
        [Out] StringBuilder id
    );
}
