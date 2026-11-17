// SPDX-FileCopyrightText: 2026 Nerva contributors
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
    internal static Dictionary<string, object> Capture(Rectangle bounds)
    {
        if ((long)bounds.Width * bounds.Height > 16L * 1024 * 1024)
        {
            throw new InvalidOperationException("source-pixels");
        }
        double scale = Math.Min(1.0, Math.Min(1280.0 / bounds.Width, 720.0 / bounds.Height));
        int width = Math.Max(1, (int)Math.Floor(bounds.Width * scale));
        int height = Math.Max(1, (int)Math.Floor(bounds.Height * scale));
        using (
            Bitmap original = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb)
        )
        using (Graphics source = Graphics.FromImage(original))
        using (Bitmap resized = new Bitmap(width, height, PixelFormat.Format24bppRgb))
        using (Graphics target = Graphics.FromImage(resized))
        {
            source.CopyFromScreen(
                bounds.X,
                bounds.Y,
                0,
                0,
                bounds.Size,
                CopyPixelOperation.SourceCopy
            );
            target.InterpolationMode = InterpolationMode.HighQualityBilinear;
            target.DrawImage(original, new Rectangle(0, 0, width, height));
            ImageCodecInfo codec = null;
            foreach (ImageCodecInfo entry in ImageCodecInfo.GetImageEncoders())
            {
                if (entry.MimeType == "image/jpeg")
                {
                    codec = entry;
                }
            }
            if (codec == null)
            {
                throw new InvalidOperationException("image-codec-unavailable");
            }
            foreach (long quality in new long[] { 80, 60, 40, 20 })
            {
                using (EncoderParameters parameters = new EncoderParameters(1))
                using (MemoryStream bytes = new MemoryStream())
                {
                    parameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);
                    resized.Save(bytes, codec, parameters);
                    if (bytes.Length > 90000)
                    {
                        continue;
                    }
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
        throw new InvalidOperationException("inline-image-limit");
    }
}
