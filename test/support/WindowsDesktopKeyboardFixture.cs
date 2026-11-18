// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Web.Script.Serialization;

/// <summary>Actual C# key planning and foreground gates run with deterministic in-memory native boundaries.</summary>
internal static class WindowsDesktopKeyboardFixture
{
    private static int checks;

    private sealed class Target : INexaConnectorHostKeyboardTarget
    {
        internal string FocusFailure;
        internal int FailCheck;
        internal int Checks;

        public void Focus()
        {
            if (FocusFailure != null)
                throw new InvalidOperationException(FocusFailure);
        }

        public void Check()
        {
            if (++Checks == FailCheck)
                throw new InvalidOperationException("keyboard-target-stale");
        }

        public void Dispose() { }
    }

    private sealed class Sender : INexaConnectorHostKeyboardSender
    {
        internal readonly HashSet<ushort> DownKeys = new HashSet<ushort>();
        internal readonly List<NexaConnectorHostKeyboardStroke[]> Batches =
            new List<NexaConnectorHostKeyboardStroke[]>();
        internal uint First = UInt32.MaxValue;
        internal bool RejectRelease;
        public int Error
        {
            get { return 5; }
        }

        public bool Down(ushort key)
        {
            return DownKeys.Contains(key);
        }

        public uint Send(NexaConnectorHostKeyboardStroke[] input)
        {
            Batches.Add((NexaConnectorHostKeyboardStroke[])input.Clone());
            uint accepted =
                Batches.Count == 1 && First != UInt32.MaxValue ? First
                : Batches.Count > 1 && RejectRelease ? 0
                : (uint)input.Length;
            for (int index = 0; index < Math.Min(accepted, (uint)input.Length); index++)
            {
                if (input[index].Key == 0)
                    continue;
                if ((input[index].Flags & 2) == 0)
                    DownKeys.Add(input[index].Key);
                else
                    DownKeys.Remove(input[index].Key);
            }
            return accepted;
        }
    }

    public static int Main()
    {
        try
        {
            Sender chord = new Sender();
            NexaConnectorHostKeyboard.Key("Control+l", "press", "", new Target(), chord);
            Assert(chord.Batches.Count == 1 && chord.Batches[0].Length == 4, "atomic-chord");
            Stroke(chord.Batches[0][0], 0x11, 0, 0);
            Stroke(chord.Batches[0][1], 'L', 0, 0);
            Stroke(chord.Batches[0][2], 'L', 0, 2);
            Stroke(chord.Batches[0][3], 0x11, 0, 2);
            Assert(chord.DownKeys.Count == 0, "complete-chord-release");

            Sender compound = new Sender();
            NexaConnectorHostKeyboard.Key("Control+Shift+F12", "press", "", new Target(), compound);
            Assert(
                compound.Batches.Count == 1 && compound.Batches[0].Length == 6,
                "multi-modifier"
            );
            Stroke(compound.Batches[0][4], 0x10, 0, 2);
            Stroke(compound.Batches[0][5], 0x11, 0, 2);
            Sender extended = new Sender();
            NexaConnectorHostKeyboard.Key("Meta+Left", "press", "", new Target(), extended);
            Stroke(extended.Batches[0][0], 0x5B, 0, 1);
            Stroke(extended.Batches[0][2], 0x25, 0, 3);

            foreach (
                string key in new[]
                {
                    "Control+Control+l",
                    "Control+",
                    "+l",
                    "l+Control",
                    "Control+Shift",
                    "Control+Alt+Shift+Meta+Control+l",
                    "F01",
                }
            )
            {
                Sender invalid = new Sender();
                Failure(
                    delegate
                    {
                        NexaConnectorHostKeyboard.Key(key, "press", "", new Target(), invalid);
                    },
                    null
                );
                Assert(invalid.Batches.Count == 0, "invalid-no-input");
            }
            foreach (string action in new[] { "up", "down" })
                Failure(
                    delegate
                    {
                        NexaConnectorHostKeyboard.Key(
                            "Control+l",
                            action,
                            "",
                            new Target(),
                            new Sender()
                        );
                    },
                    "key-chord"
                );

            Sender denied = new Sender();
            Failure(
                delegate
                {
                    NexaConnectorHostKeyboard.Key(
                        "Control+l",
                        "press",
                        "",
                        new Target { FocusFailure = "keyboard-focus-denied" },
                        denied
                    );
                },
                "keyboard-focus-denied"
            );
            Failure(
                delegate
                {
                    NexaConnectorHostKeyboard.Text(
                        "private",
                        new Target { FocusFailure = "keyboard-focus-denied" },
                        denied
                    );
                },
                "keyboard-focus-denied"
            );
            Assert(denied.Batches.Count == 0, "focus-denial-no-input");
            Sender stale = new Sender();
            Failure(
                delegate
                {
                    NexaConnectorHostKeyboard.Key(
                        "Control+l",
                        "press",
                        "",
                        new Target { FailCheck = 1 },
                        stale
                    );
                },
                "keyboard-target-stale"
            );
            Assert(stale.Batches.Count == 0, "stale-no-input");

            Sender borrowed = new Sender();
            borrowed.DownKeys.Add(0x11);
            NexaConnectorHostKeyboard.Key("Control+l", "press", "Control", new Target(), borrowed);
            Assert(
                borrowed.Batches[0].Length == 2 && borrowed.DownKeys.Contains(0x11),
                "borrowed-not-released"
            );
            Sender physical = new Sender();
            physical.DownKeys.Add(0x11);
            Failure(
                delegate
                {
                    NexaConnectorHostKeyboard.Key("Control+l", "press", "", new Target(), physical);
                },
                "keyboard-modifiers-active"
            );
            Assert(
                physical.Batches.Count == 0 && physical.DownKeys.Contains(0x11),
                "physical-not-released"
            );
            Failure(
                delegate
                {
                    NexaConnectorHostKeyboard.Key(
                        "l",
                        "press",
                        "Control",
                        new Target(),
                        new Sender()
                    );
                },
                "keyboard-owned-input-changed"
            );

            foreach (uint accepted in new uint[] { 1, 2, 3 })
            {
                Sender partial = new Sender { First = accepted };
                Failure(
                    delegate
                    {
                        NexaConnectorHostKeyboard.Key(
                            "Control+l",
                            "press",
                            "",
                            new Target(),
                            partial
                        );
                    },
                    "keyboard-input-partial"
                );
                Assert(
                    partial.DownKeys.Count == 0 && partial.Batches.Count == 2,
                    "partial-owned-release"
                );
                Assert(
                    partial.Batches[1][partial.Batches[1].Length - 1].Key == 0x11,
                    "partial-reverse-release"
                );
            }
            Sender blocked = new Sender { First = 0 };
            Failure(
                delegate
                {
                    NexaConnectorHostKeyboard.Key("Control+l", "press", "", new Target(), blocked);
                },
                "keyboard-input-rejected"
            );
            Assert(blocked.Batches.Count == 1, "zero-no-invented-release");
            Sender release = new Sender { First = 2, RejectRelease = true };
            Failure(
                delegate
                {
                    NexaConnectorHostKeyboard.Key("Control+l", "press", "", new Target(), release);
                },
                "keyboard-release-unconfirmed"
            );

            Sender held = new Sender();
            Failure(
                delegate
                {
                    NexaConnectorHostKeyboard.Key(
                        "Shift",
                        "down",
                        "",
                        new Target { FailCheck = 2 },
                        held
                    );
                },
                "keyboard-focus-changed"
            );
            Assert(held.Batches.Count == 2 && held.DownKeys.Count == 0, "changed-held-release");

            string text = "A\ud83d\ude80\n";
            Sender unicode = new Sender();
            NexaConnectorHostKeyboard.Text(text, new Target(), unicode);
            Assert(
                unicode.Batches.Count == 1 && unicode.Batches[0].Length == text.Length * 2,
                "atomic-unicode"
            );
            for (int index = 0; index < text.Length; index++)
            {
                Stroke(unicode.Batches[0][index * 2], 0, text[index], 4);
                Stroke(unicode.Batches[0][index * 2 + 1], 0, text[index], 6);
            }
            Sender partialText = new Sender { First = 1 };
            Failure(
                delegate
                {
                    NexaConnectorHostKeyboard.Text("a", new Target(), partialText);
                },
                "keyboard-input-partial"
            );
            Stroke(partialText.Batches[1][0], 0, 'a', 6);
            foreach (string invalid in new[] { "\0", "\ud800", "\udc00", new string('x', 16385) })
                Failure(
                    delegate
                    {
                        NexaConnectorHostKeyboard.Text(invalid, new Target(), new Sender());
                    },
                    "keyboard-text-invalid"
                );
            Failure(
                delegate
                {
                    NexaConnectorHostKeyboard.Text(
                        "private",
                        new Target { FailCheck = 2 },
                        new Sender()
                    );
                },
                "keyboard-focus-changed"
            );

            string token = "win32:v1:00000000000000ff:0000002a:01dc000000000001:00000037";
            Assert(
                NexaConnectorHostDesktopWindow.Format(NexaConnectorHostDesktopWindow.Parse(token))
                    == token,
                "target-roundtrip"
            );
            foreach (
                string invalid in new[]
                {
                    null,
                    "",
                    token + "\n",
                    token.ToUpperInvariant(),
                    token.Replace("0000002a", "00000000"),
                }
            )
                Failure(
                    delegate
                    {
                        NexaConnectorHostDesktopWindow.Parse(invalid);
                    },
                    null
                );
            Console.WriteLine(
                new JavaScriptSerializer().Serialize(
                    new Dictionary<string, object>
                    {
                        { "checks", checks },
                        { "chordBatches", chord.Batches.Count },
                        { "unicodeBatches", unicode.Batches.Count },
                        { "deniedBatches", denied.Batches.Count },
                    }
                )
            );
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            return 70;
        }
    }

    private static void Stroke(NexaConnectorHostKeyboardStroke value, int key, int scan, uint flags)
    {
        Assert(value.Key == key && value.Scan == scan && value.Flags == flags, "stroke");
    }

    private static void Assert(bool value, string name)
    {
        checks++;
        if (!value)
            throw new InvalidOperationException("fixture-" + name);
    }

    private static void Failure(Action action, string reason)
    {
        try
        {
            action();
        }
        catch (Exception error)
        {
            Assert(
                (error is InvalidOperationException || error is Win32Exception)
                    && (reason == null || error.Message == reason),
                "failure-" + reason
            );
            return;
        }
        throw new InvalidOperationException("fixture-missing-failure-" + reason);
    }
}
