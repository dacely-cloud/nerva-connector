// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

/// <summary>Only finite reason/code metadata crosses the native diagnostic boundary, never a field value or name.</summary>
internal sealed class NexaConnectorHostTextFieldFailure : Exception
{
    internal readonly uint NativeCode;

    internal NexaConnectorHostTextFieldFailure(string reason, Exception cause)
        : base(reason)
    {
        Exception current = cause;
        for (int depth = 0; current != null && depth < 4; depth++, current = current.InnerException)
        {
            COMException com = current as COMException;
            Win32Exception win32 = current as Win32Exception;
            if (com != null)
            {
                NativeCode = unchecked((uint)com.ErrorCode);
                break;
            }
            if (win32 != null)
            {
                NativeCode = unchecked((uint)win32.NativeErrorCode);
                break;
            }
        }
    }
}

internal interface INexaConnectorHostTextFieldTarget
{
    uint ProcessId { get; }
    void Check();
}

internal interface INexaConnectorHostTextFieldValue
{
    bool ReadOnly { get; }
    string Value { get; }
    void Replace(string text);
}

internal interface INexaConnectorHostTextFieldElement
{
    string Name { get; }
    string AutomationId { get; }
    uint ProcessId { get; }
    bool Enabled { get; }
    bool Password { get; }
    int[] Identity { get; }
    INexaConnectorHostTextFieldValue Editable { get; }
    INexaConnectorHostTextFieldElement Child();
    INexaConnectorHostTextFieldElement Sibling();
    INexaConnectorHostTextFieldElement Parent();
}

/// <summary>Exact app-scoped replacement never requests focus or falls back to global keyboard injection.</summary>
internal static class NexaConnectorHostTextField
{
    private const int MaximumElements = 512;
    private const int MaximumDepth = 24;

    private sealed class Visit
    {
        internal INexaConnectorHostTextFieldElement Element;
        internal int Depth;
    }

    private sealed class WindowTarget : INexaConnectorHostTextFieldTarget
    {
        private readonly NexaConnectorHostDesktopWindow window;

        internal WindowTarget(NexaConnectorHostDesktopWindow value)
        {
            window = value;
        }

        public uint ProcessId
        {
            get { return window.ProcessId; }
        }

        public void Check()
        {
            window.CheckIdentity();
        }
    }

    internal static void Replace(string text, string field, NexaConnectorHostDesktopWindow window)
    {
        Validate(text, field);
        window.CheckIdentity();
        Exception failure = null;
        Thread automation = new Thread(
            delegate()
            {
                try
                {
                    INexaConnectorHostTextFieldElement root =
                        NexaConnectorHostTextFieldAutomation.Open(window.Handle);
                    Replace(text, field, new WindowTarget(window), root);
                }
                catch (Exception error)
                {
                    failure = error;
                }
            }
        );
        automation.SetApartmentState(ApartmentState.MTA);
        automation.Start();
        automation.Join();
        if (failure != null)
            throw failure;
    }

    /// <summary>A read-only bounded search proves uniqueness before the single addressed replacement call.</summary>
    internal static void Replace(
        string text,
        string field,
        INexaConnectorHostTextFieldTarget target,
        INexaConnectorHostTextFieldElement root
    )
    {
        Validate(text, field);
        INexaConnectorHostTextFieldElement selected = null;
        INexaConnectorHostTextFieldValue value = null;
        int[] identity = null;
        try
        {
            target.Check();
            if (root == null || root.ProcessId != target.ProcessId)
                Fail("keyboard-field-unavailable");
            List<Visit> pending = new List<Visit>();
            INexaConnectorHostTextFieldElement child = root.Child();
            if (child != null)
                pending.Add(new Visit { Element = child, Depth = 1 });
            Stopwatch elapsed = Stopwatch.StartNew();
            int count = 0;
            bool unsupported = false;
            bool readOnly = false;
            while (pending.Count > 0)
            {
                int last = pending.Count - 1;
                Visit current = pending[last];
                pending.RemoveAt(last);
                if (
                    ++count > MaximumElements
                    || current.Depth > MaximumDepth
                    || elapsed.ElapsedMilliseconds > 1800
                )
                    Fail("keyboard-field-search-limit");
                INexaConnectorHostTextFieldElement element = current.Element;
                if (
                    String.Equals(element.Name, field, StringComparison.Ordinal)
                    || String.Equals(element.AutomationId, field, StringComparison.Ordinal)
                )
                {
                    INexaConnectorHostTextFieldValue pattern = element.Editable;
                    if (
                        element.ProcessId != target.ProcessId
                        || pattern == null
                        || element.Password
                    )
                        unsupported = true;
                    else if (!element.Enabled || pattern.ReadOnly)
                        readOnly = true;
                    else
                    {
                        if (selected != null)
                            Fail("keyboard-field-ambiguous");
                        selected = element;
                        value = pattern;
                        identity = Identity(element.Identity);
                    }
                }
                INexaConnectorHostTextFieldElement sibling = element.Sibling();
                child = element.Child();
                if (sibling != null)
                    pending.Add(new Visit { Element = sibling, Depth = current.Depth });
                if (child != null)
                    pending.Add(new Visit { Element = child, Depth = current.Depth + 1 });
            }
            if (selected == null)
                Fail(
                    readOnly ? "keyboard-field-read-only"
                    : unsupported ? "keyboard-field-unsupported"
                    : "keyboard-field-not-found"
                );
            target.Check();
            if (
                selected.ProcessId != target.ProcessId
                || !selected.Enabled
                || value.ReadOnly
                || !Same(identity, Identity(selected.Identity))
            )
                Fail("keyboard-field-unavailable");
            INexaConnectorHostTextFieldElement ancestor = selected;
            int[] rootIdentity = Identity(root.Identity);
            bool contained = false;
            for (
                int depth = 0;
                ancestor != null && depth <= MaximumDepth;
                depth++, ancestor = ancestor.Parent()
            )
            {
                if (ancestor.ProcessId != target.ProcessId)
                    Fail("keyboard-field-unavailable");
                if (Same(rootIdentity, Identity(ancestor.Identity)))
                {
                    contained = true;
                    break;
                }
            }
            if (!contained)
                Fail("keyboard-field-unavailable");
        }
        catch (NexaConnectorHostTextFieldFailure)
        {
            throw;
        }
        catch (Exception failure)
        {
            throw new NexaConnectorHostTextFieldFailure("keyboard-field-unavailable", failure);
        }

        try
        {
            target.Check();
        }
        catch (Exception failure)
        {
            throw new NexaConnectorHostTextFieldFailure("keyboard-field-unavailable", failure);
        }
        try
        {
            value.Replace(text);
            Stopwatch readback = Stopwatch.StartNew();
            do
            {
                target.Check();
                if (
                    selected.ProcessId != target.ProcessId
                    || !Same(identity, Identity(selected.Identity))
                )
                    Fail("keyboard-field-write-unconfirmed");
                string actual = value.Value;
                if (actual == null || actual.Length > 16384)
                    Fail("keyboard-field-write-unconfirmed");
                if (String.Equals(actual, text, StringComparison.Ordinal))
                    return;
                Thread.Sleep(10);
            } while (readback.ElapsedMilliseconds < 200);
            Fail("keyboard-field-write-unconfirmed");
        }
        catch (Exception failure)
        {
            throw new NexaConnectorHostTextFieldFailure(
                "keyboard-field-write-unconfirmed",
                failure
            );
        }
    }

    private static void Validate(string text, string field)
    {
        NexaConnectorHostKeyboard.ValidateText(text);
        if (String.IsNullOrEmpty(field) || field.Length > 256 || field.IndexOf('\0') >= 0)
            Fail("keyboard-field-invalid");
    }

    private static int[] Identity(int[] value)
    {
        if (value == null || value.Length == 0 || value.Length > 64)
            throw new NexaConnectorHostTextFieldFailure("keyboard-field-unavailable", null);
        return (int[])value.Clone();
    }

    private static bool Same(int[] left, int[] right)
    {
        if (left == null || right == null || left.Length != right.Length)
            return false;
        for (int index = 0; index < left.Length; index++)
            if (left[index] != right[index])
                return false;
        return true;
    }

    private static void Fail(string reason)
    {
        throw new NexaConnectorHostTextFieldFailure(reason, null);
    }
}
