// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;

/// <summary>Pure launcher checks run under Mono without invoking any Windows kernel operation.</summary>
public static class WindowsBootstrapProcessFixture
{
    private static int checks;

    public static void Main()
    {
        Check(NexaConnectorBootstrapProcess.Quote("") == "\"\"");
        Check(NexaConnectorBootstrapProcess.Quote("a b") == "\"a b\"");
        Check(NexaConnectorBootstrapProcess.Quote("a\"b") == "\"a\\\"b\"");
        Check(NexaConnectorBootstrapProcess.Quote("a\\\"b") == "\"a\\\\\\\"b\"");
        Check(NexaConnectorBootstrapProcess.Quote("C:\\data\\") == "\"C:\\data\\\\\"");
        Reject(
            delegate()
            {
                NexaConnectorBootstrapProcess.Quote("a\0b");
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorBootstrapProcess.Quote(new string('a', 32767));
            }
        );
        Dictionary<string, string> environment = new Dictionary<string, string>
        {
            { "PATH", "C:\\Windows\\System32" },
            { "node_options", "--require=C:\\unsafe.js" },
            { "NODE_PATH", "C:\\unsafe" },
            { "NODE_EXTRA_CA_CERTS", "C:\\unsafe.pem" },
            { "NODE_REPL_EXTERNAL_MODULE", "C:\\unsafe.js" },
            { "NODE_V8_COVERAGE", "C:\\unsafe" },
            { "NODE_TLS_REJECT_UNAUTHORIZED", "0" },
            { "=C:", "C:\\tasks" },
        };
        string block = NexaConnectorBootstrapProcess.EnvironmentBlock(environment);
        Check(block.EndsWith("\0\0", StringComparison.Ordinal));
        Check(block.IndexOf("PATH=C:\\Windows\\System32\0", StringComparison.Ordinal) >= 0);
        Check(block.IndexOf("=C:=C:\\tasks\0", StringComparison.Ordinal) >= 0);
        Check(block.IndexOf("NODE_TLS_REJECT_UNAUTHORIZED=1\0", StringComparison.Ordinal) >= 0);
        foreach (
            string name in new string[]
            {
                "NODE_OPTIONS",
                "NODE_PATH",
                "NODE_EXTRA_CA_CERTS",
                "NODE_REPL_EXTERNAL_MODULE",
                "NODE_V8_COVERAGE",
            }
        )
        {
            Check(block.IndexOf(name + "=", StringComparison.OrdinalIgnoreCase) < 0);
        }
        Reject(
            delegate()
            {
                NexaConnectorBootstrapProcess.EnvironmentBlock(
                    new Dictionary<string, string> { { "BAD=KEY", "value" } }
                );
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorBootstrapProcess.EnvironmentBlock(
                    new Dictionary<string, string> { { "KEY", "bad\0value" } }
                );
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorBootstrapProcess.EnvironmentBlock(
                    new Dictionary<string, string> { { "KEY", new string('x', 32767) } }
                );
            }
        );
        Dictionary<string, string> oversized = new Dictionary<string, string>();
        for (int i = 0; i < 9; i++)
        {
            oversized.Add("KEY" + i, new string('x', 32700));
        }
        Reject(
            delegate()
            {
                NexaConnectorBootstrapProcess.EnvironmentBlock(oversized);
            }
        );
        Dictionary<string, string> crowded = new Dictionary<string, string>();
        for (int i = 0; i < 4097; i++)
        {
            crowded.Add("KEY" + i, "value");
        }
        Reject(
            delegate()
            {
                NexaConnectorBootstrapProcess.EnvironmentBlock(crowded);
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorBootstrapProcess.Run("relative.exe", new string[0], "relative", false);
            }
        );
        Console.WriteLine("windows-bootstrap-process-checks=" + checks);
    }

    private static void Check(bool value)
    {
        if (!value)
        {
            throw new InvalidOperationException("bootstrap-fixture-failed");
        }
        checks++;
    }

    private static void Reject(Action action)
    {
        try
        {
            action();
        }
        catch (InvalidOperationException)
        {
            checks++;
            return;
        }
        throw new InvalidOperationException("bootstrap-fixture-accepted-invalid");
    }
}
