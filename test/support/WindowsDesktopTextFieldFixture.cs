// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

/// <summary>Pure provider fixtures prove app-scoped selection, pre-write certainty, readback and privacy.</summary>
internal static class WindowsDesktopTextFieldFixture
{
    private static int checks;
    private static int identities;

    private sealed class Target : INexaConnectorHostTextFieldTarget
    {
        internal int Calls;
        internal int FailAt;
        internal bool Stale;
        public uint ProcessId
        {
            get { return 42; }
        }

        public void Check()
        {
            if (++Calls == FailAt || Stale)
                throw new InvalidOperationException("private provider failure");
        }
    }

    private sealed class Pattern : INexaConnectorHostTextFieldValue
    {
        internal bool Locked;
        internal bool ThrowWrite;
        internal bool WrongValue;
        internal bool ThrowRead;
        internal int Writes;
        internal string Text = "private old account value";
        internal Action AfterWrite;
        public bool ReadOnly
        {
            get { return Locked; }
        }
        public string Value
        {
            get
            {
                if (ThrowRead)
                    throw new InvalidOperationException("private read value");
                return Text;
            }
        }

        public void Replace(string text)
        {
            Writes++;
            Text = WrongValue ? "private wrong value" : text;
            if (AfterWrite != null)
                AfterWrite();
            if (ThrowWrite)
                throw new COMException("private setter failure", unchecked((int)0x80070005));
        }
    }

    private sealed class Element : INexaConnectorHostTextFieldElement
    {
        internal readonly int Id = ++identities;
        internal string Label = "private field";
        internal string Automation = "exact-id";
        internal uint Pid = 42;
        internal bool Disabled;
        internal bool Secret;
        internal bool StaleIdentity;
        internal int Reads;
        internal Pattern Pattern = new Pattern();
        internal Element First;
        internal Element Next;
        internal Element Up;
        public string Name
        {
            get { return Label; }
        }
        public string AutomationId
        {
            get { return Automation; }
        }
        public uint ProcessId
        {
            get { return Pid; }
        }
        public bool Enabled
        {
            get { return !Disabled; }
        }
        public bool Password
        {
            get { return Secret; }
        }
        public int[] Identity
        {
            get { return new[] { 42, StaleIdentity && ++Reads > 1 ? Id + 10000 : Id }; }
        }
        public INexaConnectorHostTextFieldValue Editable
        {
            get { return Pattern; }
        }

        public INexaConnectorHostTextFieldElement Child()
        {
            return First;
        }

        public INexaConnectorHostTextFieldElement Sibling()
        {
            return Next;
        }

        public INexaConnectorHostTextFieldElement Parent()
        {
            return Up;
        }
    }

    private static Element Root(Element field)
    {
        Element root = new Element
        {
            First = field,
            Label = "root",
            Pattern = null,
        };
        field.Up = root;
        return root;
    }

    private static void Replace(Element field, string selector)
    {
        NexaConnectorHostTextField.Replace("replacement", selector, new Target(), Root(field));
    }

    private static void Assert(bool value, string reason)
    {
        checks++;
        if (!value)
            throw new InvalidOperationException("fixture-" + reason);
    }

    private static Exception Failure(Action action, string reason)
    {
        try
        {
            action();
        }
        catch (Exception error)
        {
            Assert(error.Message == reason, "reason-" + reason);
            Assert(!error.ToString().Contains("private"), "private-data-not-exposed");
            return error;
        }
        throw new InvalidOperationException("fixture-missing-" + reason);
    }

    public static int Main()
    {
        try
        {
            Assert(NexaConnectorHostTextFieldEdit.SupportedClass("Edit"), "standard-edit-class");
            Assert(
                NexaConnectorHostTextFieldEdit.SupportedClass(
                    "WindowsForms10.EDIT.app.0.8a6cfa_r8_ad1"
                ),
                "windows-forms-edit-class"
            );
            foreach (
                string denied in new[]
                {
                    null,
                    "",
                    "Chrome_RenderWidgetHostHWND",
                    "RichEdit20W",
                    "WindowsForms10.BUTTON.app.0.8a6cfa_r8_ad1",
                    "NotAnEdit",
                }
            )
                Assert(
                    !NexaConnectorHostTextFieldEdit.SupportedClass(denied),
                    "unsupported-control-class"
                );
            Element field = new Element();
            Replace(field, "private field");
            Assert(
                field.Pattern.Writes == 1 && field.Pattern.Text == "replacement",
                "name-replace"
            );
            Element id = new Element();
            NexaConnectorHostTextField.Replace("", "exact-id", new Target(), Root(id));
            Assert(id.Pattern.Writes == 1 && id.Pattern.Text == "", "id-clear");
            Element label = new Element { Pattern = null };
            Element unique = new Element();
            label.Next = unique;
            Element withLabel = Root(label);
            unique.Up = withLabel;
            NexaConnectorHostTextField.Replace("value", "private field", new Target(), withLabel);
            Assert(unique.Pattern.Writes == 1, "unique-editable-not-label");

            Element absent = new Element();
            Failure(
                delegate
                {
                    Replace(absent, "PRIVATE FIELD");
                },
                "keyboard-field-not-found"
            );
            Assert(absent.Pattern.Writes == 0, "not-found-no-write");
            Element duplicate = new Element();
            Element duplicateTwo = new Element();
            duplicate.Next = duplicateTwo;
            Element ambiguous = Root(duplicate);
            duplicateTwo.Up = ambiguous;
            Failure(
                delegate
                {
                    NexaConnectorHostTextField.Replace(
                        "value",
                        "private field",
                        new Target(),
                        ambiguous
                    );
                },
                "keyboard-field-ambiguous"
            );
            Assert(
                duplicate.Pattern.Writes == 0 && duplicateTwo.Pattern.Writes == 0,
                "ambiguous-no-write"
            );
            Element locked = new Element();
            locked.Pattern.Locked = true;
            Failure(
                delegate
                {
                    Replace(locked, "exact-id");
                },
                "keyboard-field-read-only"
            );
            Assert(locked.Pattern.Writes == 0, "readonly-no-write");
            Element disabled = new Element { Disabled = true };
            Failure(
                delegate
                {
                    Replace(disabled, "exact-id");
                },
                "keyboard-field-read-only"
            );
            Assert(disabled.Pattern.Writes == 0, "disabled-no-write");
            Element unsupported = new Element { Pattern = null };
            Failure(
                delegate
                {
                    Replace(unsupported, "exact-id");
                },
                "keyboard-field-unsupported"
            );
            Element password = new Element { Secret = true };
            Failure(
                delegate
                {
                    Replace(password, "exact-id");
                },
                "keyboard-field-unsupported"
            );
            Assert(password.Pattern.Writes == 0, "password-no-unverifiable-write");
            Element foreign = new Element { Pid = 99 };
            Failure(
                delegate
                {
                    Replace(foreign, "exact-id");
                },
                "keyboard-field-unsupported"
            );
            Assert(foreign.Pattern.Writes == 0, "foreign-process-no-write");
            Element stale = new Element { StaleIdentity = true };
            Failure(
                delegate
                {
                    Replace(stale, "exact-id");
                },
                "keyboard-field-unavailable"
            );
            Assert(stale.Pattern.Writes == 0, "stale-id-no-write");
            Element moved = new Element();
            Element movedRoot = Root(moved);
            moved.Up = new Element();
            Failure(
                delegate
                {
                    NexaConnectorHostTextField.Replace(
                        "value",
                        "exact-id",
                        new Target(),
                        movedRoot
                    );
                },
                "keyboard-field-unavailable"
            );
            Assert(moved.Pattern.Writes == 0, "reparented-no-write");
            Element before = new Element();
            Failure(
                delegate
                {
                    NexaConnectorHostTextField.Replace(
                        "value",
                        "exact-id",
                        new Target { FailAt = 2 },
                        Root(before)
                    );
                },
                "keyboard-field-unavailable"
            );
            Assert(before.Pattern.Writes == 0, "target-before-write");

            Element large = new Element { Label = "other", Automation = "other" };
            Element previous = large;
            Element largeRoot = Root(large);
            for (int index = 0; index < 512; index++)
            {
                Element next = new Element
                {
                    Label = "other",
                    Automation = "other",
                    Up = largeRoot,
                };
                previous.Next = next;
                previous = next;
            }
            Failure(
                delegate
                {
                    NexaConnectorHostTextField.Replace("value", "absent", new Target(), largeRoot);
                },
                "keyboard-field-search-limit"
            );

            Element incorrect = new Element();
            incorrect.Pattern.WrongValue = true;
            Failure(
                delegate
                {
                    Replace(incorrect, "exact-id");
                },
                "keyboard-field-write-unconfirmed"
            );
            Assert(incorrect.Pattern.Writes == 1, "mismatch-not-retried");
            Element failed = new Element();
            failed.Pattern.ThrowWrite = true;
            Exception setter = Failure(
                delegate
                {
                    Replace(failed, "exact-id");
                },
                "keyboard-field-write-unconfirmed"
            );
            Assert(
                failed.Pattern.Writes == 1
                    && ((NexaConnectorHostTextFieldFailure)setter).NativeCode == 0x80070005,
                "setter-uncertainty-native-code"
            );
            Element disappeared = new Element();
            Target after = new Target();
            disappeared.Pattern.AfterWrite = delegate
            {
                after.Stale = true;
            };
            Failure(
                delegate
                {
                    NexaConnectorHostTextField.Replace(
                        "value",
                        "exact-id",
                        after,
                        Root(disappeared)
                    );
                },
                "keyboard-field-write-unconfirmed"
            );
            Assert(disappeared.Pattern.Writes == 1, "target-after-write-uncertain");
            Element unreadable = new Element();
            unreadable.Pattern.ThrowRead = true;
            Failure(
                delegate
                {
                    Replace(unreadable, "exact-id");
                },
                "keyboard-field-write-unconfirmed"
            );
            Assert(unreadable.Pattern.Writes == 1, "readback-uncertain");
            foreach (string invalid in new[] { "", new string('x', 257), "\0" })
                Failure(
                    delegate
                    {
                        Replace(new Element(), invalid);
                    },
                    "keyboard-field-invalid"
                );
            Console.WriteLine(
                new JavaScriptSerializer().Serialize(
                    new Dictionary<string, object>
                    {
                        { "checks", checks },
                        { "backgroundWrites", field.Pattern.Writes },
                        {
                            "ambiguousWrites",
                            duplicate.Pattern.Writes + duplicateTwo.Pattern.Writes
                        },
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
}
