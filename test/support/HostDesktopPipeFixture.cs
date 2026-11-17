// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

/// <summary>Exercises the actual native pipe decoder without calling any desktop APIs.</summary>
internal static class HostDesktopPipeFixture
{
    public static int Main(string[] arguments)
    {
        try
        {
            Dictionary<string, object> request = NexaConnectorHostDesktop.ReadRequest(Console.OpenStandardInput());
            string text = request["text"] as string;
            if (text == null) return 70;
            byte[] bytes = new UTF8Encoding(false, true).GetBytes(text);
            string digest;
            using (SHA256 hash = SHA256.Create()) digest = BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                { "arguments", arguments }, { "operation", request["operation"] },
                { "textUtf8Bytes", bytes.Length }, { "textSha256", digest }
            }));
            return 0;
        }
        catch { return 70; }
    }
}
