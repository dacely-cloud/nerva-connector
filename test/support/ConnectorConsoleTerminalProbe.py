# SPDX-FileCopyrightText: 2026 Nerva contributors
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Drive the built connector console in an owned PTY: resizes, slash actions, completion, views and quit."""

import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from collections.abc import Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ConnectorTerminalScreen import Screen


def main(node: str, entry: str, root: str) -> None:
    master, slave = pty.openpty()
    before = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    screen = Screen(80, 24)
    child = subprocess.Popen(
        [node, entry, "connect", "--config", root + "/missing.json"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=root,
        env={"PATH": os.environ["PATH"], "HOME": root, "NODE_OPTIONS": ""},
        close_fds=True,
    )
    data = b""

    def read(timeout: float) -> bool:
        nonlocal data
        if not select.select([master], [], [], timeout)[0]:
            return False
        chunk = os.read(master, 65536)
        data += chunk
        screen.feed(chunk)
        if len(data) > 1048576:
            raise RuntimeError("Unbounded terminal output")
        return True

    def wait(predicate: Callable[[str], bool], label: str) -> None:
        end = time.monotonic() + 8
        while time.monotonic() < end:
            if predicate(screen.text()):
                quiet = time.monotonic() + 2
                while read(0.15) and time.monotonic() < quiet:
                    pass
                if predicate(screen.text()):
                    return
            if child.poll() is not None:
                raise RuntimeError("Terminal exited before the requested state")
            read(0.05)
        raise RuntimeError("Terminal state was not observed: " + label + "\n" + screen.text())

    def resize(columns: int, rows: int, label: str) -> None:
        clears = screen.clears
        screen.resize(columns, rows)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.kill(child.pid, signal.SIGWINCH)
        wait(lambda value: "Can't connect" in value and screen.clears > clears, label)

    try:
        wait(lambda value: "Can't connect" in value and "connector files" in value, "startup")
        assert b"255;106;42" in data
        assert re.search(rb"\x1b\[[0-9;]*m", data)
        resize(52, 20, "resize")
        resize(80, 24, "restore-size")
        while read(0.3):
            pass
        written = len(data)
        end = time.monotonic() + 2.5
        while time.monotonic() < end:
            read(0.05)
        assert len(data) == written, "The idle console kept repainting, which clears the user's selection"
        os.write(master, b"/permissions\r")
        wait(lambda value: "verified signed Linux installation" in value, "permissions")
        os.write(master, b"/reconnect\r")
        wait(
            lambda value: "/ menu" in value and "verified signed Linux installation" not in value,
            "reconnect-after-permissions",
        )
        os.write(master, b"/he")
        wait(lambda value: "Show every command" in value, "palette")
        os.write(master, b"\x1b[B\r")
        wait(lambda value: "Show every command" in value and "Esc close" in value, "help")
        os.write(master, b"re\t\r")
        wait(lambda value: "/ menu" in value and "Show every command" not in value, "reconnect-completion")
        os.write(master, b"\t")
        wait(lambda value: "/ Activity" in value and "requests so far" in value, "activity-view")
        os.write(master, b"\t")
        wait(lambda value: "Tab activity" in value and "/ Activity" not in value, "home-view")
        os.write(master, b"/quit\r")
        end = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < end:
            read(0.05)
        assert child.wait(timeout=0.1) == 0
        while read(0.05):
            pass
        assert b"\x1b[?1049l" in data
        assert termios.tcgetattr(slave) == before
        print("terminal-verified")
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
