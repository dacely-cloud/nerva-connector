// SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;

/// <summary>A small bounded log of starts, stops and updates in %LOCALAPPDATA%\Nerva Connector\Logs\supervisor.log.</summary>
internal sealed class NexaConnectorSupervisorLog
{
    private const long MaximumBytes = 262144;
    private readonly string path;
    private readonly object gate = new object();

    internal NexaConnectorSupervisorLog(string path)
    {
        this.path = path;
    }

    /// <summary>The installed launcher and silent setup write to the same local diagnostic log.</summary>
    internal static NexaConnectorSupervisorLog ForCurrentUser()
    {
        return new NexaConnectorSupervisorLog(
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Nerva Connector",
                "Logs",
                "supervisor.log"
            )
        );
    }

    /// <summary>Appends one timestamped line; logging never stops the connector.</summary>
    internal void Write(string message)
    {
        lock (gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                FileInfo info = new FileInfo(path);
                if (info.Exists && info.Length > MaximumBytes)
                {
                    string previous = path + ".1";
                    if (File.Exists(previous))
                    {
                        File.Delete(previous);
                    }
                    File.Move(path, previous);
                }
                File.AppendAllText(
                    path,
                    DateTime.UtcNow.ToString("o")
                        + " "
                        + message.Replace('\r', ' ').Replace('\n', ' ')
                        + "\r\n"
                );
            }
            catch (IOException)
            {
                /* Logging is best effort. */
            }
            catch (UnauthorizedAccessException)
            {
                /* As above. */
            }
        }
    }
}
