// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

/// <summary>Bounded desktop interaction in the current user's interactive Win32 session.</summary>
internal static partial class NexaConnectorHostDesktop
{
    private const int RequestBytes = 128 * 1024;

    internal static int Run()
    {
        int result = 70;
        Thread desktop = new Thread(
            delegate()
            {
                result = RunInteractive();
            }
        );
        desktop.SetApartmentState(ApartmentState.STA);
        desktop.Start();
        desktop.Join();
        return result;
    }

    /// <summary>Shell COM uses an STA only for desktop commands; process and terminal brokers retain their normal apartment.</summary>
    private static int RunInteractive()
    {
        try
        {
            Dictionary<string, object> request = ReadRequest(Console.OpenStandardInput());
            SetProcessDPIAware();
            JavaScriptSerializer serializer = new JavaScriptSerializer
            {
                MaxJsonLength = RequestBytes,
                RecursionLimit = 4,
            };
            string operation = (string)request["operation"];
            bool available = Available();
            Rectangle bounds = new Rectangle(
                GetSystemMetrics(76),
                GetSystemMetrics(77),
                GetSystemMetrics(78),
                GetSystemMetrics(79)
            );
            if (operation == "info")
            {
                Fields(request, "operation");
                Console.WriteLine(
                    serializer.Serialize(
                        new Dictionary<string, object>
                        {
                            { "available", available },
                            { "x", available ? bounds.X : 0 },
                            { "y", available ? bounds.Y : 0 },
                            { "width", available ? bounds.Width : 0 },
                            { "height", available ? bounds.Height : 0 },
                        }
                    )
                );
                return 0;
            }
            if (!available || bounds.Width <= 0 || bounds.Height <= 0)
            {
                return 70;
            }
            if (operation == "application-open")
            {
                Fields(request, "operation", "name");
                Dictionary<string, object> result = NexaConnectorHostApplication.Open(
                    Text(request, "name")
                );
                if ((string)result["status"] == "launched")
                {
                    try
                    {
                        result["screenshot"] = NexaConnectorHostDesktopFrame.Capture(bounds);
                    }
                    catch
                    {
                        result["screenshot"] = null;
                    }
                }
                serializer.MaxJsonLength = 131072;
                Console.WriteLine(serializer.Serialize(result));
                return 0;
            }
            if (operation == "snapshot")
            {
                Fields(request, "operation");
                serializer.MaxJsonLength = 131072;
                Console.WriteLine(
                    serializer.Serialize(NexaConnectorHostDesktopFrame.Capture(bounds))
                );
                return 0;
            }
            if (operation == "screenshot")
            {
                Fields(request, "operation", "maximumWidth", "maximumHeight");
                Capture(
                    bounds,
                    Count(request, "maximumWidth", 1, 2048),
                    Count(request, "maximumHeight", 1, 2048)
                );
                return 0;
            }
            if (operation == "pointer")
            {
                Fields(request, "operation", "x", "y", "button", "action");
                int x = Count(request, "x", bounds.Left, bounds.Right - 1);
                int y = Count(request, "y", bounds.Top, bounds.Bottom - 1);
                string action = Text(request, "action");
                if (action != "move" && action != "click" && action != "down" && action != "up")
                {
                    return 70;
                }
                if (action == "move" ? request["button"] != null : !(request["button"] is string))
                {
                    return 70;
                }
                if (!SetCursorPos(x, y))
                {
                    return 70;
                }
                if (action != "move")
                {
                    Button(Text(request, "button"), action);
                }
            }
            else if (operation == "button-up")
            {
                Fields(request, "operation", "button");
                Button(Text(request, "button"), "up");
            }
            else if (operation == "key")
            {
                Fields(request, "operation", "key", "action");
                Key(Text(request, "key"), Text(request, "action"));
            }
            else if (operation == "text")
            {
                Fields(request, "operation", "text");
                string text = Text(request, "text");
                if (Encoding.UTF8.GetByteCount(text) > 16384)
                {
                    return 70;
                }
                foreach (char character in text)
                {
                    if (character == '\0')
                    {
                        return 70;
                    }
                    Input[] input = { Keyboard(0, character, 4), Keyboard(0, character, 6) };
                    Send(input);
                }
            }
            else
            {
                return 70;
            }
            Console.WriteLine("{\"ok\":true}");
            return 0;
        }
        catch
        {
            return 70;
        }
    }

    /// <summary>Reads one bounded strict UTF-8 JSON request from the inherited private input pipe.</summary>
    internal static Dictionary<string, object> ReadRequest(Stream input)
    {
        byte[] buffer = new byte[4096];
        using (MemoryStream bytes = new MemoryStream())
        {
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
            {
                if (bytes.Length + count > RequestBytes)
                {
                    throw new InvalidOperationException("desktop-input-limit");
                }
                bytes.Write(buffer, 0, count);
            }
            string json = new UTF8Encoding(false, true).GetString(bytes.ToArray());
            JavaScriptSerializer serializer = new JavaScriptSerializer
            {
                MaxJsonLength = RequestBytes,
                RecursionLimit = 4,
            };
            Dictionary<string, object> request = serializer.Deserialize<Dictionary<string, object>>(
                json
            );
            if (
                request == null
                || !request.ContainsKey("operation")
                || !(request["operation"] is string)
            )
            {
                throw new InvalidOperationException("desktop-operation");
            }
            return request;
        }
    }

    private static bool Available()
    {
        if (!Environment.UserInteractive)
        {
            return false;
        }
        IntPtr desktop = OpenInputDesktop(0, false, 0x101);
        if (desktop == IntPtr.Zero)
        {
            return false;
        }
        try
        {
            StringBuilder name = new StringBuilder(256);
            uint length;
            return GetUserObjectInformationW(desktop, 2, name, 512, out length)
                && name.ToString() == "Default";
        }
        finally
        {
            CloseDesktop(desktop);
        }
    }

    private static void Capture(Rectangle bounds, int maximumWidth, int maximumHeight)
    {
        if ((long)bounds.Width * bounds.Height > 16L * 1024 * 1024)
        {
            throw new InvalidOperationException("source-pixels");
        }
        double scale = Math.Min(
            1.0,
            Math.Min((double)maximumWidth / bounds.Width, (double)maximumHeight / bounds.Height)
        );
        int width = Math.Max(1, (int)Math.Floor(bounds.Width * scale));
        int height = Math.Max(1, (int)Math.Floor(bounds.Height * scale));
        using (
            Bitmap original = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb)
        )
        using (Graphics graphics = Graphics.FromImage(original))
        {
            graphics.CopyFromScreen(
                bounds.X,
                bounds.Y,
                0,
                0,
                bounds.Size,
                CopyPixelOperation.SourceCopy
            );
            using (Bitmap resized = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            using (Graphics target = Graphics.FromImage(resized))
            using (MemoryStream bytes = new MemoryStream())
            {
                target.InterpolationMode = InterpolationMode.HighQualityBilinear;
                target.DrawImage(original, new Rectangle(0, 0, width, height));
                resized.Save(bytes, ImageFormat.Png);
                if (bytes.Length > 16L * 1024 * 1024 + 65536)
                {
                    throw new InvalidOperationException("image-limit");
                }
                bytes.Position = 0;
                bytes.CopyTo(Console.OpenStandardOutput());
            }
        }
    }

    private static void Button(string button, string action)
    {
        uint down =
            button == "left" ? 2u
            : button == "right" ? 8u
            : button == "middle" ? 32u
            : 0u;
        if (down == 0)
        {
            throw new InvalidOperationException("button");
        }
        if (action == "click")
        {
            Send(new Input[] { Mouse(down), Mouse(down * 2) });
        }
        else
        {
            Send(new Input[] { Mouse(action == "down" ? down : down * 2) });
        }
    }

    private static void Key(string key, string action)
    {
        Dictionary<string, ushort> keys = new Dictionary<string, ushort>
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
        ushort value;
        if (!keys.TryGetValue(key, out value))
        {
            int function;
            if (
                key.Length == 1
                && (
                    (key[0] >= 'a' && key[0] <= 'z')
                    || (key[0] >= 'A' && key[0] <= 'Z')
                    || (key[0] >= '0' && key[0] <= '9')
                )
            )
            {
                value = Char.ToUpperInvariant(key[0]);
            }
            else if (
                key.StartsWith("F", StringComparison.Ordinal)
                && Int32.TryParse(key.Substring(1), out function)
                && function >= 1
                && function <= 12
            )
            {
                value = (ushort)(0x6F + function);
            }
            else
            {
                throw new InvalidOperationException("key");
            }
        }
        uint extended = value >= 0x21 && value <= 0x2E || value == 0x5B ? 1u : 0u;
        if (action == "press")
        {
            Send(new Input[] { Keyboard(value, 0, extended), Keyboard(value, 0, extended | 2) });
        }
        else if (action == "down" || action == "up")
        {
            Send(new Input[] { Keyboard(value, 0, action == "up" ? extended | 2 : extended) });
        }
        else
        {
            throw new InvalidOperationException("key-action");
        }
    }

    private static Input Mouse(uint flags)
    {
        return new Input
        {
            Type = 0,
            Value = new InputUnion { Mouse = new MouseInput { Flags = flags } },
        };
    }

    private static Input Keyboard(ushort key, ushort scan, uint flags)
    {
        return new Input
        {
            Type = 1,
            Value = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    Key = key,
                    Scan = scan,
                    Flags = flags,
                },
            },
        };
    }

    private static void Send(Input[] input)
    {
        if (SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Input))) != input.Length)
        {
            throw new InvalidOperationException("input-not-delivered");
        }
    }

    private static void Fields(Dictionary<string, object> request, params string[] names)
    {
        if (request.Count != names.Length)
        {
            throw new InvalidOperationException("desktop-fields");
        }
        foreach (string name in names)
        {
            if (!request.ContainsKey(name))
            {
                throw new InvalidOperationException("desktop-fields");
            }
        }
    }

    private static string Text(Dictionary<string, object> request, string name)
    {
        string value = request[name] as string;
        if (value == null || value.IndexOf('\0') >= 0)
        {
            throw new InvalidOperationException("desktop-text");
        }
        return value;
    }

    private static int Count(
        Dictionary<string, object> request,
        string name,
        int minimum,
        int maximum
    )
    {
        if (!(request[name] is int))
        {
            throw new InvalidOperationException("desktop-count");
        }
        int value = (int)request[name];
        if (value < minimum || value > maximum)
        {
            throw new InvalidOperationException("desktop-count");
        }
        return value;
    }
}
