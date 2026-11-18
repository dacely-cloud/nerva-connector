// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Threading;

/// <summary>Reserved tokens reject arbitrary event names; one owned random event proves the actual helper dispatch.</summary>
internal static class NexaConnectorUpdateCommandFixture
{
    private static void Main(string[] arguments)
    {
        foreach (
            string name in new string[]
            {
                null,
                "",
                "Local\\OtherEvent",
                NexaConnectorUpdateCommand.EventPrefix + new string('a', 33),
                NexaConnectorUpdateCommand.EventPrefix + new string('A', 32),
                NexaConnectorUpdateCommand.EventPrefix + new string('g', 32),
            }
        )
        {
            if (NexaConnectorUpdateCommand.Request(name) != 87)
                throw new InvalidOperationException("invalid-token-accepted");
        }
        Console.WriteLine("bounded_update_names=true");
        if (arguments.Length == 2 && arguments[0] == "--native")
        {
            string name = arguments[1];
            bool created;
            using (
                EventWaitHandle requested = new EventWaitHandle(
                    false,
                    EventResetMode.AutoReset,
                    name,
                    out created
                )
            )
            using (
                NexaConnectorUpdateCommand.Replies replies = new NexaConnectorUpdateCommand.Replies(
                    name
                )
            )
            {
                if (!created)
                    throw new InvalidOperationException("update-fixture-event-not-owned");
                Thread reply = new Thread(
                    delegate()
                    {
                        bool received = requested.WaitOne(5000);
                        replies.Send(
                            received
                                ? NexaConnectorUpdateCommand.Result.Current
                                : NexaConnectorUpdateCommand.Result.Failed
                        );
                    }
                );
                reply.IsBackground = true;
                reply.Start();
                if (NexaConnectorHostProcess.Main(new string[] { "--connector-update", name }) != 0)
                {
                    throw new InvalidOperationException("update-request-not-delivered");
                }
                reply.Join();
            }
            if (NexaConnectorHostProcess.Main(new string[] { "--connector-update", name }) != 2)
                throw new InvalidOperationException("missing-supervisor-accepted");
            Console.WriteLine("native_update_dispatch=true");
        }
    }
}
