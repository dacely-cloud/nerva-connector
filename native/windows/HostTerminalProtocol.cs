// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

/// <summary>Only the private terminal broker channel accepts these bounded launch and control records.</summary>
internal static class NexaConnectorHostTerminalProtocol
{
    internal sealed class Launch
    {
        internal string Executable;
        internal StringBuilder Command;
        internal short Cols, Rows;
    }

    internal sealed class Control
    {
        internal string Id;
        internal bool Stop;
        internal short Cols, Rows;
    }

    internal static Launch ParseLaunch(string encoded)
    {
        if (encoded == null || encoded.Length > 30000) throw Invalid();
        byte[] bytes = Convert.FromBase64String(encoded);
        if (Convert.ToBase64String(bytes) != encoded) throw Invalid();
        Dictionary<string, object> value = new Reader(new UTF8Encoding(false, true).GetString(bytes)).Record();
        Fields(value, "executable", "arguments", "windowsVerbatimArguments", "cols", "rows");
        string executable = Text(value, "executable");
        string[] arguments = value["arguments"] as string[];
        if (executable.Length == 0 || arguments == null || !(value["windowsVerbatimArguments"] is bool)) throw Invalid();
        StringBuilder command = new StringBuilder(NexaConnectorHostJob.Quote(executable));
        foreach (string argument in arguments) command.Append(' ').Append((bool)value["windowsVerbatimArguments"] ? argument : NexaConnectorHostJob.Quote(argument));
        if (command.Length > 32766) throw Invalid();
        return new Launch { Executable = executable, Command = command, Cols = Dimension(value, "cols", 2, 500), Rows = Dimension(value, "rows", 1, 200) };
    }

    internal static Control ParseControl(string json, string token)
    {
        Dictionary<string, object> value = new Reader(json).Record();
        string operation = Text(value, "operation");
        if (operation == "stop") Fields(value, "token", "operation", "id");
        else if (operation == "resize") Fields(value, "token", "operation", "id", "cols", "rows");
        else throw Invalid();
        if (Text(value, "token") != token) throw Invalid();
        string id = Text(value, "id");
        long integer;
        if (id.Length == 0 || id.Length > 19 || id[0] == '0' || !Int64.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out integer) || integer < 1) throw Invalid();
        return new Control { Id = id, Stop = operation == "stop", Cols = operation == "stop" ? (short)0 : Dimension(value, "cols", 2, 500), Rows = operation == "stop" ? (short)0 : Dimension(value, "rows", 1, 200) };
    }

    internal static void ValidateStart(string json, string token)
    {
        Dictionary<string, object> value = new Reader(json).Record();
        Fields(value, "token", "operation");
        if (Text(value, "token") != token || Text(value, "operation") != "start") throw Invalid();
    }

    internal static string ReadControl(Stream stream)
    {
        byte[] bytes = new byte[4096];
        int length = 0;
        while (true)
        {
            int next = stream.ReadByte();
            if (next < 0) { if (length == 0) return null; throw Invalid(); }
            if (next == 10) return new UTF8Encoding(false, true).GetString(bytes, 0, length);
            if (length == bytes.Length) throw Invalid();
            bytes[length++] = checked((byte)next);
        }
    }

    internal static void ValidateChannel(string path, string token)
    {
        if (path == null || path.Length > 256 || !path.StartsWith("\\\\.\\pipe\\nerva-connector-host-", StringComparison.Ordinal) || path.IndexOf('\0') >= 0 || token == null || token.Length != 64) throw Invalid();
        foreach (char character in token) if ((character < '0' || character > '9') && (character < 'a' || character > 'f')) throw Invalid();
    }

    private static string Text(Dictionary<string, object> value, string name) { object raw; if (!value.TryGetValue(name, out raw) || !(raw is string)) throw Invalid(); return (string)raw; }
    private static short Dimension(Dictionary<string, object> value, string name, int minimum, int maximum) { object raw; if (!value.TryGetValue(name, out raw) || !(raw is int) || (int)raw < minimum || (int)raw > maximum) throw Invalid(); return checked((short)(int)raw); }
    private static void Fields(Dictionary<string, object> value, params string[] names) { if (value.Count != names.Length) throw Invalid(); foreach (string name in names) if (!value.ContainsKey(name)) throw Invalid(); }
    private static InvalidOperationException Invalid() { return new InvalidOperationException("terminal-contract"); }

    /// <summary>A small strict JSON reader rejects duplicate fields, noncanonical integers and unpaired Unicode before use.</summary>
    private sealed class Reader
    {
        private readonly string text;
        private int position;
        internal Reader(string value) { if (value == null || value.Length > 30000) throw Invalid(); text = value; }

        internal Dictionary<string, object> Record()
        {
            Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal);
            Take('{');
            if (!Next('}')) do { string key = String(); Take(':'); if (result.Count >= 5 || result.ContainsKey(key)) throw Invalid(); result.Add(key, Value()); } while (Next(','));
            else { End(); return result; }
            Take('}'); End(); return result;
        }

        private object Value()
        {
            Space();
            if (position >= text.Length) throw Invalid();
            if (text[position] == '"') return String();
            if (Next('['))
            {
                List<string> values = new List<string>();
                if (Next(']')) return values.ToArray();
                do { if (values.Count >= 1024) throw Invalid(); values.Add(String()); } while (Next(','));
                Take(']'); return values.ToArray();
            }
            if (Literal("true")) return true;
            if (Literal("false")) return false;
            int start = position;
            while (position < text.Length && text[position] >= '0' && text[position] <= '9') position++;
            int number;
            if (start == position || position - start > 3 || (position - start > 1 && text[start] == '0') || !Int32.TryParse(text.Substring(start, position - start), NumberStyles.None, CultureInfo.InvariantCulture, out number)) throw Invalid();
            return number;
        }

        private string String()
        {
            Take('"'); StringBuilder result = new StringBuilder();
            while (position < text.Length)
            {
                char character = text[position++];
                if (character == '"')
                {
                    string value = result.ToString();
                    if (value.IndexOf('\0') >= 0 || value.Length > 32766) throw Invalid();
                    for (int i = 0; i < value.Length; i++) if (Char.IsSurrogate(value[i]) && (!Char.IsHighSurrogate(value[i]) || ++i >= value.Length || !Char.IsLowSurrogate(value[i]))) throw Invalid();
                    return value;
                }
                if (character < 32) throw Invalid();
                if (character == '\\')
                {
                    if (position >= text.Length) throw Invalid();
                    character = text[position++];
                    if (character == 'u')
                    {
                        int code;
                        if (position + 4 > text.Length || !Int32.TryParse(text.Substring(position, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code)) throw Invalid();
                        character = (char)code; position += 4;
                    }
                    else if (character == 'b') character = '\b';
                    else if (character == 'f') character = '\f';
                    else if (character == 'n') character = '\n';
                    else if (character == 'r') character = '\r';
                    else if (character == 't') character = '\t';
                    else if (character != '"' && character != '\\' && character != '/') throw Invalid();
                }
                result.Append(character);
            }
            throw Invalid();
        }

        private bool Literal(string value) { if (position + value.Length > text.Length || System.String.CompareOrdinal(text, position, value, 0, value.Length) != 0) return false; position += value.Length; return true; }
        private bool Next(char value) { Space(); if (position >= text.Length || text[position] != value) return false; position++; return true; }
        private void Take(char value) { if (!Next(value)) throw Invalid(); }
        private void Space() { while (position < text.Length && (text[position] == ' ' || text[position] == '\t' || text[position] == '\r' || text[position] == '\n')) position++; }
        private void End() { Space(); if (position != text.Length) throw Invalid(); }
    }
}
