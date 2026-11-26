// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

/// <summary>Synthetic desktop pixels qualify encoding and native input layouts without observing the real desktop.</summary>
internal static class NexaConnectorDesktopFrameFixture
{
    private static void Main()
    {
        Dictionary<string, object> text;
        using (Bitmap bitmap = new Bitmap(3840, 2160, PixelFormat.Format24bppRgb))
        using (Graphics graphics = Graphics.FromImage(bitmap))
        using (Font font = new Font(FontFamily.GenericSansSerif, 14))
        {
            graphics.Clear(Color.White);
            for (int row = 0; row < 32; row++)
                graphics.DrawString(
                    "Desktop application: readable small text, buttons and tabs 0123456789",
                    font,
                    Brushes.Black,
                    24,
                    20 + row * 28
                );
            text = NexaConnectorHostDesktopFrame.Encode(
                bitmap,
                new Rectangle(-1920, 0, bitmap.Width, bitmap.Height)
            );
        }
        Dictionary<string, object> dense;
        using (Bitmap bitmap = new Bitmap(1920, 1080, PixelFormat.Format24bppRgb))
        {
            BitmapData data = bitmap.LockBits(
                new Rectangle(0, 0, bitmap.Width, bitmap.Height),
                ImageLockMode.WriteOnly,
                PixelFormat.Format24bppRgb
            );
            try
            {
                byte[] pixels = new byte[data.Stride * data.Height];
                new Random(17).NextBytes(pixels);
                Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
            dense = NexaConnectorHostDesktopFrame.Encode(
                bitmap,
                new Rectangle(0, 0, bitmap.Width, bitmap.Height)
            );
        }
        foreach (
            Dictionary<string, object> frame in new Dictionary<string, object>[] { text, dense }
        )
        {
            using (
                System.IO.MemoryStream bytes = new System.IO.MemoryStream(
                    Convert.FromBase64String((string)frame["data"])
                )
            )
            using (Bitmap decoded = new Bitmap(bytes))
            {
                if (decoded.Width != (int)frame["width"] || decoded.Height != (int)frame["height"])
                    throw new InvalidOperationException("encoded-geometry");
            }
        }
        Type input = typeof(NexaConnectorHostDesktop).GetNestedType(
            "Input",
            BindingFlags.NonPublic
        );
        JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 2097152 };
        Console.WriteLine(
            serializer.Serialize(
                new Dictionary<string, object>
                {
                    { "text", text },
                    { "dense", dense },
                    { "inputBytes", Marshal.SizeOf(input) },
                    { "unionOffset", Marshal.OffsetOf(input, "Value").ToInt32() },
                    { "pointerBytes", IntPtr.Size },
                }
            )
        );
    }
}
