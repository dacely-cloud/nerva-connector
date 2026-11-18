// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.ComponentModel;
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
        string diagnosticOperation = "unknown";
        try
        {
            Dictionary<string, object> request = ReadRequest(Console.OpenStandardInput());
            SetProcessDPIAware();
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            JavaScriptSerializer serializer = new JavaScriptSerializer
            {
                MaxJsonLength = RequestBytes,
                RecursionLimit = 4,
            };
            string operation = (string)request["operation"];
            if (
                new HashSet<string>
                {
                    "info",
                    "application-open",
                    "snapshot",
                    "screenshot",
                    "pointer",
                    "button-up",
                    "key",
                    "key-release",
                    "text",
                }.Contains(operation)
            )
                diagnosticOperation = operation;
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
                throw new InvalidOperationException("desktop-unavailable");
            }
            if (operation == "application-open")
            {
                bool navigate = request.ContainsKey("url");
                Fields(
                    request,
                    navigate
                        ? new string[] { "operation", "name", "url" }
                        : new string[] { "operation", "name" }
                );
                Dictionary<string, object> result = NexaConnectorHostApplication.Open(
                    Text(request, "name"),
                    navigate ? Text(request, "url") : null
                );
                if ((string)result["status"] == "launched")
                {
                    try
                    {
                        result["screenshot"] = Snapshot(bounds);
                    }
                    catch
                    {
                        result["screenshot"] = null;
                    }
                }
                serializer.MaxJsonLength = 1048576;
                Console.WriteLine(serializer.Serialize(result));
                return 0;
            }
            if (operation == "snapshot")
            {
                Fields(request, "operation");
                serializer.MaxJsonLength = 1048576;
                Console.WriteLine(serializer.Serialize(Snapshot(bounds)));
                return 0;
            }
            if (operation == "screenshot")
            {
                Fields(request, "operation", "maximumWidth", "maximumHeight");
                Capture(
                    bounds,
                    Count(request, "maximumWidth", 1, 4096),
                    Count(request, "maximumHeight", 1, 4096)
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
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "pointer-move-rejected");
                }
                CursorPoint observed;
                if (!GetCursorPos(out observed) || observed.X != x || observed.Y != y)
                    throw new InvalidOperationException("pointer-position-unconfirmed");
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
                string target = InputTarget(request);
                Fields(
                    request,
                    request.ContainsKey("held")
                        ? new[] { "operation", "key", "action", "target", "held" }
                        : new[] { "operation", "key", "action", "target" }
                );
                using (
                    NexaConnectorHostDesktopWindow window = NexaConnectorHostDesktopWindow.Acquire(
                        target
                    )
                )
                    NexaConnectorHostKeyboard.Key(
                        Text(request, "key"),
                        Text(request, "action"),
                        request.ContainsKey("held") ? Text(request, "held") : "",
                        window,
                        new KeyboardSender()
                    );
            }
            else if (operation == "key-release")
            {
                Fields(request, "operation", "key");
                NexaConnectorHostKeyboard.Release(Text(request, "key"), new KeyboardSender());
            }
            else if (operation == "text")
            {
                string target = InputTarget(request);
                if (request.ContainsKey("field") || request.ContainsKey("replace"))
                {
                    if (
                        !request.ContainsKey("field")
                        || !request.ContainsKey("replace")
                        || !(request["field"] is string)
                        || !(request["replace"] is bool)
                        || !(bool)request["replace"]
                    )
                        throw new NexaConnectorHostTextFieldFailure("keyboard-field-invalid", null);
                    Fields(request, "operation", "text", "target", "field", "replace");
                    using (
                        NexaConnectorHostDesktopWindow window =
                            NexaConnectorHostDesktopWindow.Acquire(target)
                    )
                        NexaConnectorHostTextField.Replace(
                            Text(request, "text"),
                            Text(request, "field"),
                            window
                        );
                }
                else
                {
                    Fields(request, "operation", "text", "target");
                    using (
                        NexaConnectorHostDesktopWindow window =
                            NexaConnectorHostDesktopWindow.Acquire(target)
                    )
                        NexaConnectorHostKeyboard.Text(
                            Text(request, "text"),
                            window,
                            new KeyboardSender()
                        );
                }
            }
            else
            {
                return 70;
            }
            Console.WriteLine("{\"ok\":true}");
            return 0;
        }
        catch (Exception failure)
        {
            HashSet<string> reasons = new HashSet<string>
            {
                "input-not-delivered",
                "pointer-move-rejected",
                "pointer-position-unconfirmed",
                "keyboard-focus-unavailable",
                "keyboard-focus-changed",
                "keyboard-target-required",
                "keyboard-target-invalid",
                "keyboard-target-stale",
                "keyboard-target-unavailable",
                "keyboard-focus-denied",
                "keyboard-modifiers-active",
                "keyboard-key-active",
                "keyboard-owned-input-changed",
                "keyboard-text-invalid",
                "keyboard-input-rejected",
                "keyboard-input-partial",
                "keyboard-release-unconfirmed",
                "keyboard-field-invalid",
                "keyboard-field-unsupported",
                "keyboard-field-not-found",
                "keyboard-field-ambiguous",
                "keyboard-field-read-only",
                "keyboard-field-unavailable",
                "keyboard-field-search-limit",
                "keyboard-field-write-unconfirmed",
                "key-chord",
                "desktop-unavailable",
                "application-name",
                "application-browser-url",
                "application-browser-name",
                "application-launch-rejected",
                "application-catalog-limit",
                "desktop-fields",
                "desktop-input-limit",
                "desktop-operation",
                "source-pixels",
                "inline-image-limit",
                "image-limit",
                "image-codec-unavailable",
                "source-geometry",
                "key",
                "key-action",
                "button",
            };
            string reason = reasons.Contains(failure.Message)
                ? failure.Message
                : "operation-failed";
            Win32Exception native = failure as Win32Exception;
            NexaConnectorHostTextFieldFailure fieldFailure =
                failure as NexaConnectorHostTextFieldFailure;
            Console.Error.WriteLine(
                "NERVA_DESKTOP operation="
                    + diagnosticOperation
                    + " reason="
                    + reason
                    + " native="
                    + (
                        fieldFailure != null ? fieldFailure.NativeCode
                        : native == null ? 0u
                        : unchecked((uint)native.NativeErrorCode)
                    ).ToString()
            );
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

    /// <summary>Only bind a screenshot to a window that stayed foreground throughout capture.</summary>
    private static Dictionary<string, object> Snapshot(Rectangle bounds)
    {
        string target = NexaConnectorHostDesktopWindow.ForegroundTarget();
        Dictionary<string, object> frame = NexaConnectorHostDesktopFrame.Capture(bounds);
        if (target != null && target == NexaConnectorHostDesktopWindow.ForegroundTarget())
        {
            frame["windowTarget"] = target;
        }
        return frame;
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

    /// <summary>Missing targets never fall back to a newly focused unrelated application.</summary>
    private static string InputTarget(Dictionary<string, object> request)
    {
        object value;
        if (!request.TryGetValue("target", out value) || value == null)
            throw new InvalidOperationException("keyboard-target-required");
        string token = value as string;
        if (token == null)
            throw new InvalidOperationException("keyboard-target-invalid");
        NexaConnectorHostDesktopWindow.Parse(token);
        return token;
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
            throw new Win32Exception(Marshal.GetLastWin32Error(), "input-not-delivered");
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
