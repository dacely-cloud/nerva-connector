# SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Drive the current built connector in owned PTYs without permitting network startup."""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from types import TracebackType

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ConnectorTerminalScreen import Screen


WELCOME = "Welcome to Nerva Connector"
NAME = "What should we call this computer?"
ACCESS = "What can Nexa do here?"
FOLDER = "Where should Nexa start?"
NOTE = "Add a note (optional)"
REVIEW = "Ready to connect"
LINK_FAILED = "Couldn't open this computer's connector files"
NOT_LINKED = "Not linked"
TEXT_SCREENS = (NAME, FOLDER, NOTE)
CHOICE_SCREENS = (WELCOME, ACCESS, REVIEW, LINK_FAILED)


class Terminal:
    """Own one bounded transcript, child and PTY pair through every test outcome."""

    def __init__(self, node: str, entry: str, root: str) -> None:
        self.root = root
        self.master, self.slave = pty.openpty()
        self.before = termios.tcgetattr(self.slave)
        self.data = b""
        self.screen = Screen(110, 32)
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
        self.child = subprocess.Popen(
            [node, entry, "connector"],
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            env={"PATH": os.environ["PATH"], "HOME": root, "NODE_OPTIONS": "", "TERM": "xterm-256color"},
            close_fds=True,
        )

    def __enter__(self) -> "Terminal":
        return self

    def __exit__(self, kind: type | None, value: BaseException | None, traceback: TracebackType | None) -> None:
        try:
            if self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=3)
        finally:
            os.close(self.master)
            os.close(self.slave)

    def read(self, timeout: float = 0.05) -> bool:
        if not select.select([self.master], [], [], timeout)[0]:
            return False
        try:
            chunk = os.read(self.master, 65536)
        except OSError:
            return False
        self.data += chunk
        self.screen.feed(chunk)
        if len(self.data) > 2097152:
            raise RuntimeError("Unbounded terminal output")
        return True

    def settle(self) -> None:
        """Read until the connector has been quiet briefly, so a repaint split across writes is complete."""
        end = time.monotonic() + 2
        while self.read(0.15) and time.monotonic() < end:
            pass

    def frame(self) -> str:
        return self.screen.text()

    def wait(self, text: str, after: int | None = None) -> None:
        end = time.monotonic() + 10
        while time.monotonic() < end:
            screen = self.frame()
            ready = self.screen.cursor_visible if text in TEXT_SCREENS else "\u203a" in screen if text in CHOICE_SCREENS else True
            if ready and text in screen and (after is None or len(self.data) > after):
                self.settle()
                if text in self.frame():
                    return
            if self.child.poll() is not None:
                raise RuntimeError("Connector exited before TUI state: " + text)
            self.read()
        raise RuntimeError("TUI state deadline: " + text + "\n" + self.frame()[-1800:])

    def send(self, value: bytes) -> None:
        os.write(self.master, value)

    def advance(self, value: bytes, label: str) -> None:
        written = len(self.data)
        self.send(value)
        self.wait(label, written)

    def resize(self, columns: int, rows: int, label: str) -> None:
        clears = self.screen.clears
        self.screen.resize(columns, rows)
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.kill(self.child.pid, signal.SIGWINCH)
        end = time.monotonic() + 10
        while self.screen.clears <= clears:
            if time.monotonic() > end:
                raise RuntimeError("Resizing did not repaint the whole screen: " + label)
            if self.child.poll() is not None:
                raise RuntimeError("Connector exited before repainting for: " + label)
            self.read()
        self.wait(label)

    def finish(self) -> None:
        end = time.monotonic() + 5
        while self.child.poll() is None and time.monotonic() < end:
            self.read()
        assert self.child.wait(timeout=0.1) == 0
        while select.select([self.master], [], [], 0.02)[0]:
            before = len(self.data)
            self.read(0)
            if before == len(self.data):
                break
        assert termios.tcgetattr(self.slave) == self.before, "Terminal mode was not restored"
        assert b"\x1b[?1049l" in self.data, "Alternate screen was not restored"


def guard(root: str) -> None:
    state = os.path.join(root, ".local", "share", "nerva-connector")
    os.makedirs(state, mode=0o700)
    with open(os.path.join(state, "offline-test-sentinel"), "w", encoding="utf-8") as output:
        output.write("prevent external network startup")
    os.chmod(os.path.join(state, "offline-test-sentinel"), 0o600)


def tree(root: str) -> list[str]:
    return sorted(os.path.relpath(os.path.join(directory, name), root) for directory, folders, files in os.walk(root) for name in folders + files)


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as source:
        return source.read()


def profile(root: str) -> str:
    return os.path.join(root, ".local", "share", "nerva-connector", "preferences", "setup.json")


def main(node: str, entry: str, root: str) -> None:
    guard(root)
    with Terminal(node, entry, root) as terminal:
        terminal.wait(WELCOME)
        assert b"\x1b[38;2;255;106;42m" in terminal.data, "Setup did not use the Nerva orange accent"
        assert b"56;189;248" not in terminal.data, "Setup still renders the former blue accent"
        assert "\u2580" in terminal.frame(), "Setup did not render the Nerva logo"
        assert "Checking secure local storage" not in terminal.frame()
        assert b"\x1b[?1049h" in terminal.data
        terminal.advance(b"\r", NAME)
        assert "\u256d" in terminal.frame(), "Setup did not render its active input control"
        terminal.advance(b"\x15\r", "Use 1 to 128 plain characters.")
        assert not os.path.exists(profile(root))
        terminal.advance(b"\x15Fixture laptop\r", ACCESS)
        terminal.advance(b"\x1b", NAME)
        terminal.advance(b"\x15Reviewed laptop\r", ACCESS)
        terminal.resize(52, 20, ACCESS)
        terminal.resize(110, 32, ACCESS)
        terminal.send(b"\x1b[B")
        terminal.advance(b"\r", FOLDER)
        assert (root + "/Nexa Tasks").encode() in terminal.data
        terminal.resize(52, 20, FOLDER)
        terminal.resize(110, 32, FOLDER)
        terminal.advance(b"\r", REVIEW)
        assert "Step 4 of 5" in terminal.frame()
        assert not os.path.exists(root + "/Nexa Tasks"), "Setup wrote before the review was confirmed"
        assert not os.path.exists(profile(root))
        terminal.advance(b"\r", LINK_FAILED)
        assert "Step 5 of 5" in terminal.frame()
        assert "Esc link later" in terminal.frame()
        with open(profile(root), encoding="utf-8") as saved:
            preferences = json.load(saved)
        assert preferences["name"] == "Reviewed laptop"
        assert preferences["tasksDirectory"] == root + "/Nexa Tasks"
        assert preferences["access"] == "full-computer"
        assert preferences["localInstructions"] == ""
        assert preferences["revision"] == "1"
        assert os.path.isdir(root + "/Nexa Tasks")
        original = read_bytes(profile(root))
        terminal.advance(b"\x1b", NOT_LINKED)
        assert "/pair" in terminal.frame()
        assert "Reviewed laptop" in terminal.frame()
        terminal.advance(b"/settings\r", NAME)
        assert "Reviewed laptop" in terminal.frame()
        assert "Step 1 of 5" in terminal.frame()
        terminal.advance(b"\x03", NOT_LINKED)
        assert read_bytes(profile(root)) == original
        terminal.send(b"/quit\r")
        terminal.finish()
    with Terminal(node, entry, root) as terminal:
        terminal.wait("Can't connect")
        assert WELCOME.encode() not in terminal.data
        assert NAME.encode() not in terminal.data
        terminal.advance(b"/settings\r", NAME)
        terminal.advance(b"\x1b", "Can't connect")
        terminal.send(b"/quit\r")
        terminal.finish()
        assert read_bytes(profile(root)) == original
    for name, keys in [("ctrl-c", [b"\x03"]), ("ctrl-d", [b"\x04"]), ("escape", [b"\x1b"]), ("review-ctrl-c", [b"\r", b"\r", b"\r", b"\r", b"\x03"])]:
        home = os.path.join(root, name)
        os.mkdir(home, 0o700)
        guard(home)
        before = tree(home)
        with Terminal(node, entry, home) as terminal:
            terminal.wait(WELCOME)
            for key in keys:
                terminal.send(key)
                time.sleep(0.15)
            terminal.finish()
            assert tree(home) == before, "Canceled setup created local state"
    state = os.path.join(root, ".local", "share", "nerva-connector")
    assert sorted(os.listdir(state)) == ["offline-test-sentinel", "preferences"]
    print("real-terminal-setup-tui-verified")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
