# SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
# SPDX-License-Identifier: LicenseRef-Proprietary

"""A small terminal screen that applies the escape sequences the connector writes, for real-PTY probes."""

import codecs
import unicodedata


class Screen:
    """Track the visible cells, cursor visibility and full clears of one terminal viewport.

    The connector repaints only rows that changed, so the latest screen cannot be found by splitting the output on
    the clear-screen sequence; it has to be reconstructed the way a terminal would.
    """

    def __init__(self, columns: int, rows: int) -> None:
        self.columns = columns
        self.rows = rows
        self.grid = [[" "] * columns for _ in range(rows)]
        self.row = 0
        self.column = 0
        self.cursor_visible = True
        self.clears = 0
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.pending = ""

    def resize(self, columns: int, rows: int) -> None:
        """Change the viewport size, keeping whatever still fits, as a terminal does before the app repaints."""
        grid = [[" "] * columns for _ in range(rows)]
        for index, line in enumerate(self.grid[:rows]):
            grid[index][: min(columns, len(line))] = line[:columns]
        self.grid = grid
        self.columns = columns
        self.rows = rows
        self.row = min(self.row, rows - 1)
        self.column = min(self.column, columns - 1)

    def text(self) -> str:
        """The visible screen, one line per row, without trailing spaces."""
        return "\n".join("".join(line).rstrip() for line in self.grid)

    def feed(self, data: bytes) -> None:
        """Apply output bytes; an escape sequence split across reads is completed by the next call."""
        text = self.pending + self.decoder.decode(data)
        self.pending = ""
        index = 0
        while index < len(text):
            character = text[index]
            if character == "\x1b":
                end = self._escape(text, index)
                if end < 0:
                    self.pending = text[index:]
                    return
                index = end
                continue
            if character == "\r":
                self.column = 0
            elif character == "\n":
                self._line_feed()
            elif character == "\b":
                self.column = max(0, self.column - 1)
            elif ord(character) >= 0x20:
                self._put(character)
            index += 1

    def _escape(self, text: str, start: int) -> int:
        if start + 1 >= len(text):
            return -1
        kind = text[start + 1]
        if kind == "[":
            end = start + 2
            while end < len(text) and not ("@" <= text[end] <= "~"):
                end += 1
            if end >= len(text):
                return -1
            self._control(text[start + 2 : end], text[end])
            return end + 1
        if kind == "]":
            end = start + 2
            while end < len(text):
                if text[end] == "\x07":
                    return end + 1
                if text[end] == "\x1b" and end + 1 < len(text) and text[end + 1] == "\\":
                    return end + 2
                end += 1
            return -1
        return start + 2

    def _control(self, parameters: str, final: str) -> None:
        private = parameters.startswith("?")
        values = [int(value) if value.isdigit() else 0 for value in parameters.lstrip("?").split(";")]
        first = values[0] if values else 0
        if private and final in "hl":
            if 25 in values:
                self.cursor_visible = final == "h"
            if 1049 in values:
                self._clear()
            return
        if final in "Hf":
            row = values[0] if len(values) > 0 and values[0] > 0 else 1
            column = values[1] if len(values) > 1 and values[1] > 0 else 1
            self.row = min(self.rows, row) - 1
            self.column = min(self.columns, column) - 1
        elif final == "J":
            if first in (2, 3):
                self._clear()
                self.clears += 1
            elif first == 0:
                self.grid[self.row][self.column :] = [" "] * (self.columns - self.column)
                for line in self.grid[self.row + 1 :]:
                    line[:] = [" "] * self.columns
        elif final == "K":
            if first == 2:
                self.grid[self.row][:] = [" "] * self.columns
            elif first == 0:
                self.grid[self.row][self.column :] = [" "] * (self.columns - self.column)
        elif final == "A":
            self.row = max(0, self.row - max(1, first))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + max(1, first))
        elif final == "C":
            self.column = min(self.columns - 1, self.column + max(1, first))
        elif final == "D":
            self.column = max(0, self.column - max(1, first))

    def _clear(self) -> None:
        self.grid = [[" "] * self.columns for _ in range(self.rows)]

    def _line_feed(self) -> None:
        if self.row + 1 < self.rows:
            self.row += 1
            return
        self.grid.pop(0)
        self.grid.append([" "] * self.columns)

    def _put(self, character: str) -> None:
        if unicodedata.combining(character):
            return
        width = 2 if unicodedata.east_asian_width(character) in ("W", "F") else 1
        if self.column + width > self.columns:
            self.column = 0
            self._line_feed()
        self.grid[self.row][self.column] = character
        if width == 2:
            self.grid[self.row][self.column + 1] = ""
        self.column += width
