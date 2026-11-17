// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Web.Script.Serialization;

/// <summary>Exercises the actual state request parser without invoking Windows APIs.</summary>
public static class WindowsStateProtocolFixture
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static int assertions;

    public static void Main(string[] arguments)
    {
        CheckStrings();
        CheckFrameworkStrings();
        CheckInvalidRequests();
        Console.WriteLine("windows-state-protocol-checks=" + assertions);
        if (arguments.Length == 1 && arguments[0] == "--benchmark")
        {
            Benchmark("plain", Request("operation-id"), 10000);
            Benchmark("escaped", Request("C:\\Users\\fixture\\state.json"), 10000);
            Benchmark("write-128KiB", Request("operation-id", new string('A', 131072)), 100);
        }
    }

    private static void CheckStrings()
    {
        string[] values =
        {
            "",
            "operation-id",
            "C:\\Users\\fixture\\state.json",
            "quote\" and slash/",
            "\0\b\f\n\r\t",
            "子😀",
            new string('A', 131072),
        };
        foreach (string value in values)
        {
            Dictionary<string, object> parsed = Parse(Request(value));
            Equal(parsed.Count, 13);
            Equal(parsed["id"], value);
            Equal(parsed["maximumBytes"], 1048576);
            Equal(parsed["initialize"], true);
            Equal(parsed["secret"], false);
            Equal(parsed["path"], null);
        }
        Equal(Parse(Request("x").Replace("\"id\"", "\"\\u0069d\""))["id"], "x");
        Equal(Parse(Request("x").Replace("\"x\"", "\"\\uD83D\\uDE00\""))["id"], "😀");
        Equal(Parse(Request("x").Replace("\"x\"", "\"\\/\""))["id"], "/");
    }

    private static void CheckFrameworkStrings()
    {
        foreach (
            string value in new string[]
            {
                "/Date(0)/",
                "/Date(-1)/",
                "/Date(123456789)/",
                "/Date(0+0100)/",
                "/Date(abc)/",
                "/Date()/",
                "x/Date(0)/",
                "/Date(0)/x",
            }
        )
        {
            string expected;
            try
            {
                expected = Json.Deserialize<string>(Json.Serialize(value));
            }
            catch (Exception)
            {
                bool rejected = false;
                try
                {
                    Parse(Request(value));
                }
                catch (Exception)
                {
                    rejected = true;
                }
                Equal(rejected, true);
                continue;
            }
            Equal(Parse(Request(value))["id"], expected);
        }
    }

    private static void CheckInvalidRequests()
    {
        string request = Request("x");
        string[] invalid =
        {
            "",
            "{}",
            request + "x",
            request.Substring(0, request.Length - 1) + ",}",
            request.Replace("\"id\":\"x\"", "\"id\":\"x\",\"id\":\"y\""),
            request.Replace("\"id\"", "\"unexpected\""),
            request.Replace("1048576", "01"),
            request.Replace("1048576", "-1"),
            request.Replace("1048576", "1.5"),
            request.Replace("1048576", "1000000000"),
            request.Replace("\"x\"", "[]"),
            request.Replace("\"x\"", "{}"),
            request.Replace("\"x\"", "\"\\q\""),
            request.Replace("\"x\"", "\"\\u12xz\""),
            request.Replace("\"x\"", "\"\\uD800\""),
            request.Replace("\"x\"", "\"\\uDC00\""),
            request.Replace("\"x\"", "\"" + '\uD800' + "\""),
            request.Replace("\"x\"", "\"raw\nnewline\""),
        };
        foreach (string value in invalid)
        {
            bool rejected = false;
            try
            {
                Parse(value);
            }
            catch (Exception)
            {
                rejected = true;
            }
            Equal(rejected, true);
        }
    }

    private static string Request(string id, string data = null)
    {
        return Json.Serialize(
            new Dictionary<string, object>
            {
                { "id", id },
                { "operation", "write" },
                { "path", null },
                { "purpose", null },
                { "lease", null },
                { "name", null },
                { "maximumBytes", 1048576 },
                { "dataBase64", data },
                { "initialize", true },
                { "secret", false },
                { "sizeBytes", null },
                { "sha256", null },
                { "replace", null },
            }
        );
    }

    private static Dictionary<string, object> Parse(string request)
    {
        return NexaConnectorStateOwner.ParseStateRequestForTest(request);
    }

    private static void Equal(object actual, object expected)
    {
        if (!Object.Equals(actual, expected))
        {
            throw new Exception("State protocol result changed");
        }
        assertions++;
    }

    private static void Benchmark(string name, string request, int iterations)
    {
        for (int index = 0; index < 100; index++)
        {
            Parse(request);
        }
        for (int round = 0; round < 7; round++)
        {
            Stopwatch elapsed = Stopwatch.StartNew();
            for (int index = 0; index < iterations; index++)
            {
                Parse(request);
            }
            elapsed.Stop();
            Console.WriteLine(
                name
                    + "="
                    + elapsed.Elapsed.TotalMilliseconds.ToString("F3", CultureInfo.InvariantCulture)
            );
        }
    }
}

public static partial class NexaConnectorStateOwner
{
    /// <summary>Exposes only the production parser to this compile-time test fixture.</summary>
    internal static Dictionary<string, object> ParseStateRequestForTest(string request)
    {
        return Parse(request);
    }
}
