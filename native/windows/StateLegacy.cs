// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using Microsoft.Win32.SafeHandles;

/// <summary>Legacy presence detection never reads or adopts data from an untrusted storage tree.</summary>
public static partial class NexaConnectorStateOwner
{
    /// <summary>
    /// Pin the verified profile and walk only fixed former storage names without following reparses.
    /// Shared .local/share folders are not secret storage: their ACLs cannot establish trust, but
    /// they need not prevent proving a fixed child absent. Only not-found permits startup; denied
    /// access, reparses and other failures remain fatal. No bytes are read and no ACLs are changed.
    /// Actual storage reads and writes continue to use OpenPath and its complete ACL validation.
    /// </summary>
    private static void RejectLegacyState(Owner owner)
    {
        using (PinnedPath path = OpenPath(owner, owner.Profile, false, false))
        {
            foreach (string name in new string[] { ".local", "share", "nerva-connector" })
            {
                if (!OpenLegacyDirectory(path, name))
                {
                    return;
                }
            }
            RejectLegacyMarkers(path.Last, false);
            if (OpenLegacyDirectory(path, "state"))
            {
                RejectLegacyMarkers(path.Last, true);
            }
        }
    }

    private static bool OpenLegacyDirectory(PinnedPath path, string name)
    {
        try
        {
            SafeFileHandle directory = Open(path.Last, name, ReadDirectory, 1, true, null, 3);
            path.Handles.Add(directory);
            CheckObject(directory, true);
            return true;
        }
        catch (Failure error)
        {
            if (error.Code != "not-found")
            {
                throw;
            }
            return false;
        }
    }

    private static void RejectLegacyMarkers(SafeFileHandle directory, bool state)
    {
        foreach (
            string name in new string[]
            {
                "device-key.json",
                "pairing-state",
                "device.json",
                "device-key.pem",
            }
        )
        {
            if (!state && name == "device-key.pem")
            {
                continue;
            }
            try
            {
                using (Open(directory, name, 0x00100080, 1, false, null, 3))
                {
                    throw new Failure("migration-required");
                }
            }
            catch (Failure error)
            {
                if (error.Code != "not-found")
                {
                    throw;
                }
            }
        }
    }
}
