// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Reflection;

/// <summary>Optional system UI Automation is reflected so Mono builds need no downloaded UI/WPF assemblies.</summary>
internal sealed class NexaConnectorHostTextFieldAutomation
{
    private readonly Type elementType;
    private readonly object walker;
    private readonly MethodInfo first;
    private readonly MethodInfo next;
    private readonly MethodInfo parent;
    private readonly MethodInfo runtimeId;
    private readonly PropertyInfo current;

    private readonly IntPtr window;

    private NexaConnectorHostTextFieldAutomation(IntPtr window)
    {
        this.window = window;
        LoadSystemAssembly("UIAutomationTypes");
        Assembly assembly = LoadSystemAssembly("UIAutomationClient");
        elementType = assembly.GetType("System.Windows.Automation.AutomationElement", true);
        Type walkerType = assembly.GetType("System.Windows.Automation.TreeWalker", true);
        walker = walkerType
            .GetField("ControlViewWalker", BindingFlags.Public | BindingFlags.Static)
            .GetValue(null);
        if (walker == null)
            throw new InvalidOperationException("keyboard-field-unsupported");
        first = Method(walkerType, "GetFirstChild", elementType);
        next = Method(walkerType, "GetNextSibling", elementType);
        parent = Method(walkerType, "GetParent", elementType);
        runtimeId = Method(elementType, "GetRuntimeId");
        current = Property(elementType, "Current");
    }

    internal static INexaConnectorHostTextFieldElement Open(IntPtr window)
    {
        try
        {
            NexaConnectorHostTextFieldAutomation bridge = new NexaConnectorHostTextFieldAutomation(
                window
            );
            object root = Method(bridge.elementType, "FromHandle", typeof(IntPtr))
                .Invoke(null, new object[] { window });
            return bridge.Wrap(root);
        }
        catch (Exception failure)
        {
            throw new NexaConnectorHostTextFieldFailure("keyboard-field-unsupported", failure);
        }
    }

    private Element Wrap(object value)
    {
        if (value == null)
            return null;
        if (!elementType.IsInstanceOfType(value))
            throw new InvalidOperationException("keyboard-field-unavailable");
        return new Element(this, value);
    }

    private sealed class Element : INexaConnectorHostTextFieldElement
    {
        private readonly NexaConnectorHostTextFieldAutomation owner;
        private readonly object element;

        internal Element(NexaConnectorHostTextFieldAutomation owner, object element)
        {
            this.owner = owner;
            this.element = element;
        }

        private object Read(string name)
        {
            object information = owner.current.GetValue(element, null);
            return Property(owner.current.PropertyType, name).GetValue(information, null);
        }

        private string Text(string name)
        {
            string value = Read(name) as string;
            if (value == null)
                throw new InvalidOperationException("keyboard-field-unavailable");
            return value.Length <= 256 ? value : "";
        }

        private bool Flag(string name)
        {
            object value = Read(name);
            if (!(value is bool))
                throw new InvalidOperationException("keyboard-field-unavailable");
            return (bool)value;
        }

        public string Name
        {
            get { return Text("Name"); }
        }
        public string AutomationId
        {
            get { return Text("AutomationId"); }
        }
        public uint ProcessId
        {
            get
            {
                object value = Read("ProcessId");
                if (!(value is int))
                    throw new InvalidOperationException("keyboard-field-unavailable");
                return unchecked((uint)(int)value);
            }
        }
        public bool Enabled
        {
            get { return Flag("IsEnabled"); }
        }
        public bool Password
        {
            get { return Flag("IsPassword"); }
        }
        public int[] Identity
        {
            get { return owner.runtimeId.Invoke(element, new object[0]) as int[]; }
        }
        public INexaConnectorHostTextFieldValue Editable
        {
            get
            {
                object value = Read("NativeWindowHandle");
                if (!(value is int))
                    throw new InvalidOperationException("keyboard-field-unavailable");
                return NexaConnectorHostTextFieldEdit.TryCreate(
                    owner.window,
                    new IntPtr((int)value)
                );
            }
        }

        public INexaConnectorHostTextFieldElement Child()
        {
            return owner.Wrap(owner.first.Invoke(owner.walker, new[] { element }));
        }

        public INexaConnectorHostTextFieldElement Sibling()
        {
            return owner.Wrap(owner.next.Invoke(owner.walker, new[] { element }));
        }

        public INexaConnectorHostTextFieldElement Parent()
        {
            return owner.Wrap(owner.parent.Invoke(owner.walker, new[] { element }));
        }
    }

    private static MethodInfo Method(Type type, string name, params Type[] arguments)
    {
        MethodInfo value = type.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static,
            null,
            arguments,
            null
        );
        if (value == null)
            throw new InvalidOperationException("keyboard-field-unsupported");
        return value;
    }

    /// <summary>Inspect metadata before loading code; application-local assemblies never supply the optional provider.</summary>
    private static Assembly LoadSystemAssembly(string name)
    {
        string identity =
            name + ", Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35";
        Assembly definition = Assembly.ReflectionOnlyLoad(identity);
        if (!definition.GlobalAssemblyCache || definition.FullName != identity)
            throw new InvalidOperationException("keyboard-field-unsupported");
        Assembly value = Assembly.Load(identity);
        if (
            !value.GlobalAssemblyCache
            || value.FullName != identity
            || value.Location != definition.Location
        )
            throw new InvalidOperationException("keyboard-field-unsupported");
        return value;
    }

    private static PropertyInfo Property(Type type, string name)
    {
        PropertyInfo value = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
        if (value == null)
            throw new InvalidOperationException("keyboard-field-unsupported");
        return value;
    }
}
