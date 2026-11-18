// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Security.AccessControl;
using System.Threading;

/// <summary>The installed updater accepts one wake signal and returns a finite status to its console.</summary>
internal static class NexaConnectorUpdateCommand
{
    internal const string EventPrefix = @"Local\NervaConnector.Update.";
    private const int ReplyTimeoutMs = 750000;
    private static readonly string[] Statuses = { "current", "installing", "failed" };

    internal enum Result
    {
        Current,
        Installing,
        Failed,
    }

    /// <summary>Owns the per-instance reply events for the lifetime of the supervisor.</summary>
    internal sealed class Replies : IDisposable
    {
        private readonly EventWaitHandle[] events;

        internal Replies(string name)
        {
            events = OpenReplies(name, true);
        }

        internal void Send(Result result)
        {
            events[(int)result].Set();
        }

        public void Dispose()
        {
            foreach (EventWaitHandle reply in events)
            {
                reply.Dispose();
            }
        }
    }

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
                EventWaitHandle[] replies = OpenReplies(name, false);
                try
                {
                    foreach (EventWaitHandle reply in replies)
                    {
                        reply.WaitOne(0);
                    }
                    if (!check.Set())
                    {
                        return 2;
                    }
                    int result = WaitHandle.WaitAny(replies, ReplyTimeoutMs);
                    Console.WriteLine(
                        result == WaitHandle.WaitTimeout
                            ? Statuses[(int)Result.Failed]
                            : Statuses[result]
                    );
                    return 0;
                }
                finally
                {
                    foreach (EventWaitHandle reply in replies)
                    {
                        reply.Dispose();
                    }
                }
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

    private static EventWaitHandle[] OpenReplies(string name, bool create)
    {
        EventWaitHandle[] replies = new EventWaitHandle[Statuses.Length];
        try
        {
            for (int index = 0; index < replies.Length; index++)
            {
                string qualified = name + "." + Statuses[index];
                replies[index] = create
                    ? new EventWaitHandle(false, EventResetMode.AutoReset, qualified)
                    : EventWaitHandle.OpenExisting(qualified, EventWaitHandleRights.Synchronize);
            }
            return replies;
        }
        catch
        {
            foreach (EventWaitHandle reply in replies)
            {
                if (reply != null)
                {
                    reply.Dispose();
                }
            }
            throw;
        }
    }
}
