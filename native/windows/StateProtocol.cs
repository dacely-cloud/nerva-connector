// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

/// <summary>Strict bounded state requests and replies are validated before dispatch.</summary>
public static partial class NexaConnectorStateOwner
{
    private static string Text(Dictionary<string, object> request, string key)
    {
        string value = request[key] as string;
        if (value == null)
        {
            throw new Failure("invalid");
        }
        return value;
    }

    private static bool Flag(Dictionary<string, object> request, string key)
    {
        if (!(request[key] is bool))
        {
            throw new Failure("invalid");
        }
        return (bool)request[key];
    }

    private static int Bound(Dictionary<string, object> request)
    {
        return Bound(request, 1048576);
    }

    private static int Bound(Dictionary<string, object> request, int maximum)
    {
        if (!(request["maximumBytes"] is int))
        {
            throw new Failure("invalid");
        }
        int bound = (int)request["maximumBytes"];
        if (bound < 1 || bound > maximum)
        {
            throw new Failure("limit");
        }
        return bound;
    }

    private static byte[] Decode(string text, int maximum)
    {
        if (text.Length > 4 * ((maximum + 2) / 3))
        {
            throw new Failure("limit");
        }
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(text);
        }
        catch
        {
            throw new Failure("invalid");
        }
        if (bytes.Length > maximum || Convert.ToBase64String(bytes) != text)
        {
            Array.Clear(bytes, 0, bytes.Length);
            throw new Failure("invalid");
        }
        return bytes;
    }

    private static void Fields(Dictionary<string, object> request, params string[] allowed)
    {
        foreach (string key in RequestFields)
        {
            if (
                key != "id"
                && key != "operation"
                && Array.IndexOf(allowed, key) < 0
                && request[key] != null
            )
            {
                throw new Failure("invalid");
            }
        }
    }

    private static bool ValidUnicode(string text)
    {
        for (int i = 0; i < text.Length; i++)
        {
            if (Char.IsSurrogate(text[i]))
            {
                if (
                    !Char.IsHighSurrogate(text[i])
                    || i + 1 >= text.Length
                    || !Char.IsLowSurrogate(text[++i])
                )
                {
                    return false;
                }
            }
        }
        return true;
    }

    private static string ReadLine()
    {
        StringBuilder line = new StringBuilder();
        while (true)
        {
            int value = Console.In.Read();
            if (value < 0)
            {
                if (line.Length != 0)
                {
                    throw new Failure("invalid");
                }
                return null;
            }
            if (value == 10)
            {
                return line.ToString();
            }
            if (line.Length >= MaximumLine)
            {
                throw new Failure("limit");
            }
            line.Append((char)value);
        }
    }

    private static Dictionary<string, object> Parse(string line)
    {
        Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal);
        int index = 0;
        Space(line, ref index);
        Take(line, ref index, '{');
        Space(line, ref index);
        while (index < line.Length && line[index] != '}')
        {
            string key = JsonString(line, ref index);
            Space(line, ref index);
            Take(line, ref index, ':');
            Space(line, ref index);
            if (Array.IndexOf(RequestFields, key) < 0 || result.ContainsKey(key))
            {
                throw new Failure("invalid");
            }
            result.Add(key, JsonValue(line, ref index));
            Space(line, ref index);
            if (index < line.Length && line[index] == '}')
            {
                break;
            }
            Take(line, ref index, ',');
            Space(line, ref index);
            if (index < line.Length && line[index] == '}')
            {
                throw new Failure("invalid");
            }
        }
        Take(line, ref index, '}');
        Space(line, ref index);
        if (index != line.Length || result.Count != RequestFields.Length)
        {
            throw new Failure("invalid");
        }
        return result;
    }

    private static object JsonValue(string line, ref int index)
    {
        if (index < line.Length && line[index] == '"')
        {
            return JsonString(line, ref index);
        }
        int begin = index;
        while (
            index < line.Length
            && line[index] != ','
            && line[index] != '}'
            && !Char.IsWhiteSpace(line[index])
        )
        {
            index++;
        }
        string token = line.Substring(begin, index - begin);
        if (token == "null")
        {
            return null;
        }
        if (token == "true")
        {
            return true;
        }
        if (token == "false")
        {
            return false;
        }
        int integer;
        if (
            Regex.IsMatch(token, "^(0|[1-9][0-9]{0,8})$")
            && Int32.TryParse(token, NumberStyles.None, CultureInfo.InvariantCulture, out integer)
        )
        {
            return integer;
        }
        throw new Failure("invalid");
    }

    /// <summary>Validates strings once; escapes and Framework date conversions use the original serializer.</summary>
    private static string JsonString(string line, ref int index)
    {
        int begin = index;
        Take(line, ref index, '"');
        bool escaped = false;
        while (index < line.Length)
        {
            char value = line[index++];
            if (value < 32)
            {
                throw new Failure("invalid");
            }
            if (value == '"')
            {
                bool frameworkDate =
                    index - begin >= 8
                    && line[begin + 1] == '/'
                    && String.CompareOrdinal(line, begin + 1, "/Date(", 0, 6) == 0;
                string text;
                try
                {
                    text =
                        escaped || frameworkDate
                            ? Json.Deserialize<string>(line.Substring(begin, index - begin))
                            : line.Substring(begin + 1, index - begin - 2);
                }
                catch
                {
                    throw new Failure("invalid");
                }
                if (!ValidUnicode(text))
                {
                    throw new Failure("invalid");
                }
                return text;
            }
            if (value == '\\')
            {
                escaped = true;
                if (index >= line.Length)
                {
                    throw new Failure("invalid");
                }
                char escape = line[index++];
                if (escape == 'u')
                {
                    if (index + 4 > line.Length)
                    {
                        throw new Failure("invalid");
                    }
                    for (int i = 0; i < 4; i++)
                    {
                        if (!Uri.IsHexDigit(line[index++]))
                        {
                            throw new Failure("invalid");
                        }
                    }
                }
                else if ("\"\\/bfnrt".IndexOf(escape) < 0)
                {
                    throw new Failure("invalid");
                }
            }
        }
        throw new Failure("invalid");
    }

    private static void Space(string line, ref int index)
    {
        while (
            index < line.Length
            && (line[index] == ' ' || line[index] == '\t' || line[index] == '\r')
        )
        {
            index++;
        }
    }

    private static void Take(string line, ref int index, char value)
    {
        if (index >= line.Length || line[index++] != value)
        {
            throw new Failure("invalid");
        }
    }

    private static void WriteReply(
        string id,
        bool ok,
        Dictionary<string, object> values,
        string error,
        string diagnostic = null
    )
    {
        Dictionary<string, object> result = new Dictionary<string, object>
        {
            { "id", id },
            { "ok", ok },
            { "path", null },
            { "lease", null },
            { "exists", null },
            { "names", null },
            { "dataBase64", null },
            { "error", error },
            { "sizeBytes", null },
            { "sha256", null },
        };
        if (values != null)
        {
            foreach (KeyValuePair<string, object> item in values)
            {
                result[item.Key] = item.Value;
            }
        }
        if (diagnostic != null)
        {
            result["diagnostic"] = diagnostic;
        }
        Console.Out.WriteLine(Json.Serialize(result));
        Console.Out.Flush();
    }
}
