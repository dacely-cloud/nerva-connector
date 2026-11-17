// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

/// <summary>One ConPTY owns fixed-size synchronous pumps; output keeps draining while the console closes.</summary>
internal sealed partial class NexaConnectorHostTerminalConsole : IDisposable
{
    private SafeFileHandle inputRead;
    private SafeFileHandle outputWrite;
    private FileStream inputWrite;
    private readonly Pump output;
    private Pump input;
    private IntPtr console;
    private bool disposed;
    private Thread closer;
    private Exception closeFailure;

    internal NexaConnectorHostTerminalConsole(
        short cols,
        short rows,
        bool probe,
        Action<bool, long> completed,
        Action failed
    )
    {
        SafeFileHandle inputWriter = null;
        SafeFileHandle outputReader = null;
        FileStream reader = null;
        Stream destination = null;
        try
        {
            if (
                !CreatePipe(out inputRead, out inputWriter, IntPtr.Zero, 32768)
                || !CreatePipe(out outputReader, out outputWrite, IntPtr.Zero, 32768)
            )
            {
                throw new IOException("terminal-pipes");
            }
            inputWrite = new FileStream(inputWriter, FileAccess.Write, 32768, false);
            inputWriter = null;
            reader = new FileStream(outputReader, FileAccess.Read, 32768, false);
            outputReader = null;
            destination = probe ? Stream.Null : Standard(-11, FileAccess.Write);
            output = new Pump(reader, destination, null, completed, failed, true);
            reader = null;
            destination = null;
            output.Start();
            int result = CreatePseudoConsole(
                new Coordinate { X = cols, Y = rows },
                inputRead,
                outputWrite,
                0,
                out console
            );
            if (result != 0 || console == IntPtr.Zero)
            {
                throw new NotSupportedException("terminal-conpty-unavailable");
            }
        }
        catch
        {
            if (inputWriter != null)
            {
                inputWriter.Dispose();
            }
            if (outputReader != null)
            {
                outputReader.Dispose();
            }
            if (reader != null)
            {
                reader.Dispose();
            }
            if (destination != null)
            {
                destination.Dispose();
            }
            Dispose();
            throw;
        }
    }

    internal IntPtr Handle
    {
        get { return console; }
    }

    internal void StartInput(Action<long> accepted, Action failed)
    {
        inputRead.Dispose();
        inputRead = null;
        outputWrite.Dispose();
        outputWrite = null;
        input = new Pump(Standard(-10, FileAccess.Read), inputWrite, accepted, null, failed, false);
        inputWrite = null;
        input.Start();
    }

    internal void Resize(short cols, short rows)
    {
        if (
            console == IntPtr.Zero
            || ResizePseudoConsole(console, new Coordinate { X = cols, Y = rows }) != 0
        )
        {
            throw new IOException("terminal-resize");
        }
    }

    internal void AbandonOutput()
    {
        if (output != null)
        {
            output.DrainOnly();
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }
        if (input != null)
        {
            input.Stop();
            input = null;
        }
        if (inputWrite != null)
        {
            inputWrite.Dispose();
            inputWrite = null;
        }
        if (inputRead != null)
        {
            inputRead.Dispose();
            inputRead = null;
        }
        if (outputWrite != null)
        {
            outputWrite.Dispose();
            outputWrite = null;
        }
        if (console != IntPtr.Zero)
        {
            IntPtr closing = console;
            console = IntPtr.Zero;
            closer = new Thread(
                delegate()
                {
                    try
                    {
                        ClosePseudoConsole(closing);
                    }
                    catch (Exception error)
                    {
                        closeFailure = error;
                    }
                }
            );
            closer.IsBackground = true;
            closer.Start();
        }
        if (closer != null)
        {
            if (!closer.Join(8000))
            {
                throw new IOException("terminal-console-close-unconfirmed");
            }
            if (closeFailure != null)
            {
                throw new IOException("terminal-console-close-unconfirmed");
            }
        }
        if (output != null)
        {
            output.Finish();
        }
        disposed = true;
    }

    private static FileStream Standard(int number, FileAccess access)
    {
        SafeFileHandle duplicate;
        IntPtr process = GetCurrentProcess();
        IntPtr handle = GetStdHandle(number);
        if (
            handle == IntPtr.Zero
            || handle == new IntPtr(-1)
            || !DuplicateHandle(process, handle, process, out duplicate, 0, false, 2)
        )
        {
            throw new IOException("terminal-standard-stream");
        }
        return new FileStream(duplicate, access, 32768, false);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Coordinate
    {
        internal short X;
        internal short Y;
    }

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern int CreatePseudoConsole(
        Coordinate size,
        SafeFileHandle input,
        SafeFileHandle output,
        uint flags,
        out IntPtr console
    );

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern int ResizePseudoConsole(IntPtr console, Coordinate size);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern void ClosePseudoConsole(IntPtr console);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(
        out SafeFileHandle read,
        out SafeFileHandle write,
        IntPtr attributes,
        uint size
    );

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int number);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess,
        IntPtr source,
        IntPtr targetProcess,
        out SafeFileHandle target,
        uint access,
        [MarshalAs(UnmanagedType.Bool)] bool inherit,
        uint options
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle OpenThread(
        uint access,
        [MarshalAs(UnmanagedType.Bool)] bool inherit,
        uint threadId
    );

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CancelSynchronousIo(SafeFileHandle thread);
}
