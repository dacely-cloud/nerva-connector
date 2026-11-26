// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

/// <summary>Portable checks compile the actual terminal broker and validate its private boundary without Windows API calls.</summary>
public static class WindowsHostTerminalFixture
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static int checks;
    private static readonly string Token = new string('a', 64);

    public static void Main()
    {
        NexaConnectorHostTerminalProtocol.Launch launch = Parse(Launch());
        Check(
            launch.Executable == "C:\\Program Files\\App\\app.exe"
                && launch.Cols == 80
                && launch.Rows == 24
        );
        Check(
            launch.Command.ToString()
                == "\"C:\\Program Files\\App\\app.exe\" \"a b\" \"a\\\"b\" C:\\data\\"
        );
        Dictionary<string, object> verbatim = Launch();
        verbatim["windowsVerbatimArguments"] = true;
        Check(
            Parse(verbatim)
                .Command.ToString()
                .EndsWith(" a b a\"b C:\\data\\", StringComparison.Ordinal)
        );
        foreach (int number in new int[] { -1, 0, 1, 501 })
        {
            Reject(
                delegate()
                {
                    Dictionary<string, object> value = Launch();
                    value["cols"] = number;
                    Parse(value);
                }
            );
        }
        foreach (int number in new int[] { -1, 0, 201 })
        {
            Reject(
                delegate()
                {
                    Dictionary<string, object> value = Launch();
                    value["rows"] = number;
                    Parse(value);
                }
            );
        }
        foreach (
            string key in new string[]
            {
                "executable",
                "arguments",
                "windowsVerbatimArguments",
                "cols",
                "rows",
            }
        )
        {
            Reject(
                delegate()
                {
                    Dictionary<string, object> value = Launch();
                    value.Remove(key);
                    Parse(value);
                }
            );
        }
        foreach (string executable in new string[] { "", "a\0b" })
        {
            Reject(
                delegate()
                {
                    Dictionary<string, object> value = Launch();
                    value["executable"] = executable;
                    Parse(value);
                }
            );
        }
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ParseLaunch(
                    Encoded(
                        "{\"executable\":\"\\ud800\",\"arguments\":[],\"windowsVerbatimArguments\":false,\"cols\":80,\"rows\":24}"
                    )
                );
            }
        );
        Reject(
            delegate()
            {
                Dictionary<string, object> value = Launch();
                value["unknown"] = true;
                Parse(value);
            }
        );
        Reject(
            delegate()
            {
                Dictionary<string, object> value = Launch();
                value["arguments"] = new string[1025];
                Parse(value);
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ParseLaunch(
                    Encoded(Json.Serialize(Launch())) + "\n"
                );
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ParseLaunch(
                    Encoded(
                        Json.Serialize(Launch()).Replace("\"cols\":80", "\"cols\":80,\"cols\":80")
                    )
                );
            }
        );
        foreach (string geometry in new string[] { "8e1", "80.0", "080", "true", "null" })
        {
            Reject(
                delegate()
                {
                    NexaConnectorHostTerminalProtocol.ParseLaunch(
                        Encoded(
                            Json.Serialize(Launch()).Replace("\"cols\":80", "\"cols\":" + geometry)
                        )
                    );
                }
            );
        }

        string resize =
            "{\"token\":\""
            + Token
            + "\",\"operation\":\"resize\",\"id\":\"9007199254740993\",\"cols\":500,\"rows\":200}";
        NexaConnectorHostTerminalProtocol.Control control =
            NexaConnectorHostTerminalProtocol.ParseControl(resize, Token);
        Check(
            !control.Stop
                && control.Id == "9007199254740993"
                && control.Cols == 500
                && control.Rows == 200
        );
        string stop = "{\"token\":\"" + Token + "\",\"operation\":\"stop\",\"id\":\"1\"}";
        Check(NexaConnectorHostTerminalProtocol.ParseControl(stop, Token).Stop);
        NexaConnectorHostTerminalProtocol.ValidateStart(
            "{\"token\":\"" + Token + "\",\"operation\":\"start\"}",
            Token
        );
        checks++;
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ValidateStart(
                    "{\"token\":\"" + new string('b', 64) + "\",\"operation\":\"start\"}",
                    Token
                );
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ValidateStart(stop, Token);
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ParseControl(
                    stop.Replace("\"id\":\"1\"", "\"id\":\"0\""),
                    Token
                );
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ParseControl(resize, new string('b', 64));
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ParseControl(
                    resize.Replace("9007199254740993", "01"),
                    Token
                );
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ParseControl(
                    resize.Replace("9007199254740993", "9223372036854775808"),
                    Token
                );
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ParseControl(
                    stop.Replace("\"stop\"", "\"write\""),
                    Token
                );
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ParseControl(
                    stop.Replace("\"id\":\"1\"", "\"id\":\"1\",\"id\":\"2\""),
                    Token
                );
            }
        );
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ParseControl(
                    stop.Replace("}", ",\"end\":true}"),
                    Token
                );
            }
        );
        using (
            MemoryStream stream = new MemoryStream(
                Encoding.UTF8.GetBytes(resize + "\n" + stop + "\n")
            )
        )
        {
            Check(NexaConnectorHostTerminalProtocol.ReadControl(stream) == resize);
            Check(NexaConnectorHostTerminalProtocol.ReadControl(stream) == stop);
            Check(NexaConnectorHostTerminalProtocol.ReadControl(stream) == null);
        }
        Reject(
            delegate()
            {
                using (MemoryStream stream = new MemoryStream(new byte[4097]))
                {
                    NexaConnectorHostTerminalProtocol.ReadControl(stream);
                }
            }
        );
        Reject(
            delegate()
            {
                using (MemoryStream stream = new MemoryStream(Encoding.UTF8.GetBytes(stop)))
                {
                    NexaConnectorHostTerminalProtocol.ReadControl(stream);
                }
            }
        );
        Reject(
            delegate()
            {
                using (MemoryStream stream = new MemoryStream(new byte[] { 0xff, 10 }))
                {
                    NexaConnectorHostTerminalProtocol.ReadControl(stream);
                }
            }
        );
        NexaConnectorHostTerminalProtocol.ValidateChannel(
            "\\\\.\\pipe\\nerva-connector-host-fixture",
            Token
        );
        checks++;
        foreach (
            string token in new string[]
            {
                new string('A', 64),
                new string('a', 63),
                Token + "\n",
                "00000000-0000-0000-0000-000000000000",
            }
        )
        {
            Reject(
                delegate()
                {
                    NexaConnectorHostTerminalProtocol.ValidateChannel(
                        "\\\\.\\pipe\\nerva-connector-host-fixture",
                        token
                    );
                }
            );
        }
        Reject(
            delegate()
            {
                NexaConnectorHostTerminalProtocol.ValidateChannel("\\\\.\\pipe\\other", Token);
            }
        );
        Console.WriteLine("windows-host-terminal-checks=" + checks);
    }

    private static Dictionary<string, object> Launch()
    {
        return new Dictionary<string, object>
        {
            { "executable", "C:\\Program Files\\App\\app.exe" },
            { "arguments", new string[] { "a b", "a\"b", "C:\\data\\" } },
            { "windowsVerbatimArguments", false },
            { "cols", 80 },
            { "rows", 24 },
        };
    }

    private static string Encoded(string json)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
    }

    private static NexaConnectorHostTerminalProtocol.Launch Parse(Dictionary<string, object> value)
    {
        return NexaConnectorHostTerminalProtocol.ParseLaunch(Encoded(Json.Serialize(value)));
    }

    private static void Check(bool value)
    {
        if (!value)
        {
            throw new InvalidOperationException("terminal-fixture-result");
        }
        checks++;
    }

    private static void Reject(Action action)
    {
        try
        {
            action();
        }
        catch
        {
            checks++;
            return;
        }
        throw new InvalidOperationException("terminal-fixture-accepted-invalid-after-" + checks);
    }
}
