// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Text;

/// <summary>Exact logical strokes are independently testable before the Win32 INPUT ABI conversion.</summary>
internal struct NexaConnectorHostKeyboardStroke
{
    internal ushort Key;
    internal ushort Scan;
    internal uint Flags;
}

/// <summary>The production sender owns only SendInput and immediate native error capture.</summary>
internal interface INexaConnectorHostKeyboardSender
{
    bool Down(ushort key);
    uint Send(NexaConnectorHostKeyboardStroke[] input);
    int Error { get; }
}

/// <summary>One bounded key chord or Unicode text batch owns its fresh key-downs and all failure releases.</summary>
internal static class NexaConnectorHostKeyboard
{
    private static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort>
    {
        { "Control", 0x11 },
        { "Alt", 0x12 },
        { "Shift", 0x10 },
        { "Meta", 0x5B },
        { "Enter", 0x0D },
        { "Tab", 9 },
        { "Escape", 0x1B },
        { "Backspace", 8 },
        { "Delete", 0x2E },
        { "Insert", 0x2D },
        { "Home", 0x24 },
        { "End", 0x23 },
        { "PageUp", 0x21 },
        { "PageDown", 0x22 },
        { "Up", 0x26 },
        { "Down", 0x28 },
        { "Left", 0x25 },
        { "Right", 0x27 },
        { "Space", 0x20 },
    };
    private static readonly string[] Modifiers = { "Control", "Alt", "Shift", "Meta" };

    internal static void Key(
        string key,
        string action,
        string held,
        INexaConnectorHostKeyboardTarget target,
        INexaConnectorHostKeyboardSender sender
    )
    {
        HashSet<string> borrowed = Held(held);
        NexaConnectorHostKeyboardStroke[] input = Plan(key, action, borrowed);
        ushort primary = Value(key.Substring(key.LastIndexOf('+') + 1));
        target.Focus();
        CheckModifiers(sender, borrowed);
        if (action != "up" && sender.Down(primary))
            throw new InvalidOperationException("keyboard-key-active");
        Deliver(input, action == "down", target, sender);
    }

    internal static void Text(
        string text,
        INexaConnectorHostKeyboardTarget target,
        INexaConnectorHostKeyboardSender sender
    )
    {
        ValidateText(text);
        NexaConnectorHostKeyboardStroke[] input = new NexaConnectorHostKeyboardStroke[
            text.Length * 2
        ];
        for (int index = 0; index < text.Length; index++)
        {
            input[index * 2] = new NexaConnectorHostKeyboardStroke
            {
                Scan = text[index],
                Flags = 4,
            };
            input[index * 2 + 1] = new NexaConnectorHostKeyboardStroke
            {
                Scan = text[index],
                Flags = 6,
            };
        }
        target.Focus();
        CheckModifiers(sender, new HashSet<string>());
        if (input.Length == 0)
        {
            target.Check();
            return;
        }
        Deliver(input, false, target, sender);
    }

    internal static void ValidateText(string text)
    {
        if (text == null || text.IndexOf('\0') >= 0 || Encoding.UTF8.GetByteCount(text) > 16384)
            throw new InvalidOperationException("keyboard-text-invalid");
        for (int index = 0; index < text.Length; index++)
        {
            if (Char.IsHighSurrogate(text[index]))
            {
                if (++index >= text.Length || !Char.IsLowSurrogate(text[index]))
                    throw new InvalidOperationException("keyboard-text-invalid");
            }
            else if (Char.IsLowSurrogate(text[index]))
                throw new InvalidOperationException("keyboard-text-invalid");
        }
    }

    /// <summary>Only the desktop session owner calls this key-up-only path for an input it previously owned.</summary>
    internal static void Release(string key, INexaConnectorHostKeyboardSender sender)
    {
        if (key == null || key.IndexOf('+') >= 0)
            throw new InvalidOperationException("key-chord");
        ushort value = Value(key);
        if (sender.Send(new[] { Stroke(value, true) }) != 1)
            throw new Win32Exception(sender.Error, "keyboard-release-unconfirmed");
    }

    /// <summary>Modifiers precede one primary key; every fresh down has an up in the same SendInput call.</summary>
    internal static NexaConnectorHostKeyboardStroke[] Plan(
        string key,
        string action,
        HashSet<string> borrowed
    )
    {
        if (key == null || key.Length == 0 || key.Length > 64)
            throw new InvalidOperationException("key");
        if (action != "press" && action != "down" && action != "up")
            throw new InvalidOperationException("key-action");
        string[] parts = key.Split(new char[] { '+' });
        if (parts.Length > 5 || (parts.Length > 1 && action != "press"))
            throw new InvalidOperationException("key-chord");
        HashSet<string> modifiers = new HashSet<string>();
        List<ushort> fresh = new List<ushort>();
        for (int index = 0; index < parts.Length - 1; index++)
        {
            if (Array.IndexOf(Modifiers, parts[index]) < 0 || !modifiers.Add(parts[index]))
                throw new InvalidOperationException("key-chord");
            if (!borrowed.Contains(parts[index]))
                fresh.Add(Value(parts[index]));
        }
        string primary = parts[parts.Length - 1];
        if (parts.Length > 1 && Array.IndexOf(Modifiers, primary) >= 0)
            throw new InvalidOperationException("key-chord");
        ushort value = Value(primary);
        List<NexaConnectorHostKeyboardStroke> input = new List<NexaConnectorHostKeyboardStroke>();
        foreach (ushort modifier in fresh)
            input.Add(Stroke(modifier, false));
        if (action != "up")
            input.Add(Stroke(value, false));
        if (action != "down")
            input.Add(Stroke(value, true));
        for (int index = fresh.Count - 1; index >= 0; index--)
            input.Add(Stroke(fresh[index], true));
        return input.ToArray();
    }

    private static ushort Value(string key)
    {
        ushort value;
        if (Keys.TryGetValue(key, out value))
            return value;
        int function;
        if (
            key.Length == 1
            && (
                (key[0] >= 'a' && key[0] <= 'z')
                || (key[0] >= 'A' && key[0] <= 'Z')
                || (key[0] >= '0' && key[0] <= '9')
            )
        )
            return Char.ToUpperInvariant(key[0]);
        if (
            key.StartsWith("F", StringComparison.Ordinal)
            && Int32.TryParse(key.Substring(1), out function)
            && function >= 1
            && function <= 12
            && key == "F" + function.ToString()
        )
            return (ushort)(0x6F + function);
        throw new InvalidOperationException("key");
    }

    private static HashSet<string> Held(string held)
    {
        if (held == null || held.Length > 26)
            throw new InvalidOperationException("keyboard-owned-input-changed");
        HashSet<string> keys = new HashSet<string>();
        if (held.Length == 0)
            return keys;
        foreach (string key in held.Split(new char[] { ',' }))
        {
            if (Array.IndexOf(Modifiers, key) < 0 || !keys.Add(key))
                throw new InvalidOperationException("keyboard-owned-input-changed");
        }
        return keys;
    }

    private static void CheckModifiers(
        INexaConnectorHostKeyboardSender sender,
        HashSet<string> borrowed
    )
    {
        foreach (ushort right in new ushort[] { 0xA1, 0xA3, 0xA5, 0x5C })
        {
            if (sender.Down(right))
                throw new InvalidOperationException("keyboard-modifiers-active");
        }
        foreach (string key in Modifiers)
        {
            bool down = sender.Down(Value(key));
            if (down && !borrowed.Contains(key))
                throw new InvalidOperationException("keyboard-modifiers-active");
            if (!down && borrowed.Contains(key))
                throw new InvalidOperationException("keyboard-owned-input-changed");
        }
    }

    private static NexaConnectorHostKeyboardStroke Stroke(ushort key, bool up)
    {
        return new NexaConnectorHostKeyboardStroke
        {
            Key = key,
            Flags = (key >= 0x21 && key <= 0x2E || key == 0x5B ? 1u : 0u) | (up ? 2u : 0u),
        };
    }

    private static void Deliver(
        NexaConnectorHostKeyboardStroke[] input,
        bool retain,
        INexaConnectorHostKeyboardTarget target,
        INexaConnectorHostKeyboardSender sender
    )
    {
        target.Check();
        uint accepted = sender.Send(input);
        int error = sender.Error;
        List<NexaConnectorHostKeyboardStroke> owned = new List<NexaConnectorHostKeyboardStroke>();
        for (int index = 0; index < Math.Min((uint)input.Length, accepted); index++)
        {
            NexaConnectorHostKeyboardStroke stroke = input[index];
            int existing = owned.FindIndex(
                delegate(NexaConnectorHostKeyboardStroke held)
                {
                    return held.Key == stroke.Key && held.Scan == stroke.Scan;
                }
            );
            if ((stroke.Flags & 2) != 0)
            {
                if (existing >= 0)
                    owned.RemoveAt(existing);
            }
            else if (existing < 0)
                owned.Add(stroke);
        }
        bool complete = false;
        try
        {
            if (accepted == 0)
                throw new Win32Exception(error, "keyboard-input-rejected");
            if (accepted != input.Length)
                throw new Win32Exception(error, "keyboard-input-partial");
            try
            {
                target.Check();
            }
            catch (Exception)
            {
                throw new InvalidOperationException("keyboard-focus-changed");
            }
            complete = true;
        }
        finally
        {
            if ((!complete || !retain) && owned.Count > 0)
            {
                owned.Reverse();
                NexaConnectorHostKeyboardStroke[] releases = owned.ToArray();
                for (int index = 0; index < releases.Length; index++)
                    releases[index].Flags |= 2;
                if (sender.Send(releases) != releases.Length)
                    throw new Win32Exception(sender.Error, "keyboard-release-unconfirmed");
            }
        }
    }
}
