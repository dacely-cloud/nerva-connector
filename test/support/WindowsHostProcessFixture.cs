// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

/// <summary>Pure native policy checks never call a Windows API or launch a desktop application.</summary>
public static class WindowsHostProcessFixture
{
    public static void Main()
    {
        uint[] errors =
        {
            0,
            2,
            3,
            5,
            8,
            10,
            14,
            50,
            120,
            126,
            193,
            206,
            216,
            267,
            577,
            740,
            1150,
            1223,
            1450,
            1816,
            UInt32.MaxValue,
        };
        string[] expected =
        {
            "operation-failed",
            "not-found",
            "not-found",
            "permission-denied",
            "resource-limit",
            "invalid-request",
            "resource-limit",
            "unsupported",
            "unsupported",
            "not-found",
            "unsupported",
            "invalid-request",
            "unsupported",
            "not-directory",
            "permission-denied",
            "permission-denied",
            "unsupported",
            "canceled",
            "resource-limit",
            "resource-limit",
            "operation-failed",
        };
        string[] arguments =
        {
            "/c",
            "C:\\tail\\",
            "",
            "a b",
            "a\"b",
            "x\\\"y",
            "C:\\tail dir\\",
            "tab\tvalue",
        };
        string[] quoted =
        {
            "/c",
            "C:\\tail\\",
            "\"\"",
            "\"a b\"",
            "\"a\\\"b\"",
            "\"x\\\\\\\"y\"",
            "\"C:\\tail dir\\\\\"",
            "\"tab\tvalue\"",
        };
        for (int index = 0; index < arguments.Length; index++)
        {
            if (NexaConnectorHostJob.Quote(arguments[index]) != quoted[index])
            {
                throw new InvalidOperationException("process-argument-quote-contract");
            }
        }
        JavaScriptSerializer json = new JavaScriptSerializer();
        for (int index = 0; index < errors.Length; index++)
        {
            NexaConnectorHostCreateException error = new NexaConnectorHostCreateException(
                errors[index]
            );
            if (error.NativeError != errors[index] || error.ErrorCode != expected[index])
            {
                throw new InvalidOperationException("process-create-error-contract");
            }
            Console.WriteLine(
                json.Serialize(
                    NexaConnectorHostProcess.Rejection(
                        "00000000-0000-0000-0000-000000000000",
                        error
                    )
                )
            );
        }
        Dictionary<string, object> canceled = NexaConnectorHostProcess.Rejection(
            "00000000-0000-0000-0000-000000000000",
            new OperationCanceledException()
        );
        if ((string)canceled["errorCode"] != "canceled" || canceled["nativeError"] != null)
        {
            throw new InvalidOperationException("process-cancel-contract");
        }
        Console.WriteLine(json.Serialize(canceled));
    }
}

// These unused modes satisfy the product entry's compile-time links in this isolated fixture.
public static class NexaConnectorHostDesktop
{
    public static int Run()
    {
        throw new InvalidOperationException("desktop-not-a-fixture-operation");
    }
}

public static class NexaConnectorHostTerminal
{
    public static int Run(string[] arguments)
    {
        throw new InvalidOperationException("terminal-not-a-fixture-operation");
    }
}
