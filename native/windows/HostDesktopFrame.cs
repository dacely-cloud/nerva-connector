// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

/// <summary>One screen capture travels inside the signed result without temporary files or a separate media read.</summary>
internal static class NexaConnectorHostDesktopFrame
{
    private const int MaximumBytes = 640000;
    private const int MaximumDimension = 4096;

    internal static Dictionary<string, object> Capture(Rectangle bounds)
    {
        Validate(bounds);
        using (
            Bitmap original = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb)
        )
        using (Graphics source = Graphics.FromImage(original))
        {
            source.CopyFromScreen(
                bounds.X,
                bounds.Y,
                0,
                0,
                bounds.Size,
                CopyPixelOperation.SourceCopy
            );
            return Encode(original, bounds);
        }
    }

    /// <summary>Preserve native pixels when possible; dense screens reduce dimensions before lowering JPEG quality below 80.</summary>
    internal static Dictionary<string, object> Encode(Bitmap original, Rectangle bounds)
    {
        Validate(bounds);
        if (original.Width != bounds.Width || original.Height != bounds.Height)
            throw new InvalidOperationException("source-geometry");
        double scale = Math.Min(
            1.0,
            Math.Min(
                (double)MaximumDimension / bounds.Width,
                (double)MaximumDimension / bounds.Height
            )
        );
        ImageCodecInfo codec = null;
        foreach (ImageCodecInfo entry in ImageCodecInfo.GetImageEncoders())
        {
            if (entry.MimeType == "image/jpeg")
            {
                codec = entry;
            }
        }
        if (codec == null)
            throw new InvalidOperationException("image-codec-unavailable");
        for (int attempt = 0; attempt < 10; attempt++)
        {
            int width = Math.Max(1, (int)Math.Floor(bounds.Width * scale));
            int height = Math.Max(1, (int)Math.Floor(bounds.Height * scale));
            long encodedBytes = 0;
            using (Bitmap resized = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            using (Graphics target = Graphics.FromImage(resized))
            {
                if (width == bounds.Width && height == bounds.Height)
                    target.DrawImageUnscaled(original, 0, 0);
                else
                {
                    target.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    target.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    target.DrawImage(original, new Rectangle(0, 0, width, height));
                }
                foreach (long quality in new long[] { 90, 80 })
                {
                    using (EncoderParameters parameters = new EncoderParameters(1))
                    using (MemoryStream bytes = new MemoryStream())
                    {
                        parameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);
                        resized.Save(bytes, codec, parameters);
                        encodedBytes = bytes.Length;
                        if (encodedBytes > MaximumBytes)
                            continue;
                        return new Dictionary<string, object>
                        {
                            { "mimeType", "image/jpeg" },
                            { "data", Convert.ToBase64String(bytes.ToArray()) },
                            { "width", width },
                            { "height", height },
                            { "sourceX", bounds.X },
                            { "sourceY", bounds.Y },
                            { "sourceWidth", bounds.Width },
                            { "sourceHeight", bounds.Height },
                        };
                    }
                }
            }
            scale *= Math.Min(0.8, Math.Sqrt((double)MaximumBytes / encodedBytes) * 0.95);
        }
        throw new InvalidOperationException("inline-image-limit");
    }

    private static void Validate(Rectangle bounds)
    {
        if (
            bounds.Width < 1
            || bounds.Height < 1
            || (long)bounds.Width * bounds.Height > 16L * 1024 * 1024
        )
            throw new InvalidOperationException("source-pixels");
    }
}
