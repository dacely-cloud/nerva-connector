// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Security.AccessControl;
using System.Threading;

/// <summary>A fixed, per-instance request can only wake the installed supervisor's signed update check.</summary>
internal static class NexaConnectorUpdateCommand
{
    internal const string EventPrefix = @"Local\NervaConnector.Update.";

    /// <summary>No paths, commands or feed settings cross this boundary; the supervisor retains release authority.</summary>
    internal static int Request(string name)
    {
        if (
            name == null
            || name.Length != EventPrefix.Length + 32
            || !name.StartsWith(EventPrefix, StringComparison.Ordinal)
        )
        {
            return 87;
        }
        for (int index = EventPrefix.Length; index < name.Length; index++)
        {
            char value = name[index];
            if (!(value >= '0' && value <= '9') && !(value >= 'a' && value <= 'f'))
            {
                return 87;
            }
        }
        try
        {
            using (
                EventWaitHandle check = EventWaitHandle.OpenExisting(
                    name,
                    EventWaitHandleRights.Modify
                )
            )
            {
                return check.Set() ? 0 : 2;
            }
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            return 2;
        }
        catch (UnauthorizedAccessException)
        {
            return 5;
        }
        catch (PlatformNotSupportedException)
        {
            return 50;
        }
    }
}
