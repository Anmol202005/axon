import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";

// ===========================================================================
// MultilineInput
// ---------------------------------------------------------------------------
// A controlled multi-line text editor for the TUI.
//
//   Enter            → submit
//   \<Enter>         → newline (backslash-continuation, works in every term)
//   Alt+Enter        → newline (terminals that send "\e\r")
//   Ctrl+J           → newline (terminals that send "\n")
//   Shift+Enter      → newline (only on terminals that report shift+return)
//   ↑ / ↓            → move cursor across lines; on the first/last line we
//                      delegate to onHistoryUp / onHistoryDown so the parent
//                      can browse prompt history.
//   ← / →            → cursor left/right
//   Ctrl+A / Ctrl+E  → start / end of current line
//   Ctrl+U / Ctrl+K  → delete to start / end of current line
//   Multi-char paste → inserted at cursor as-is (terminal sends pastes as one
//                      stdin chunk, so embedded newlines come through intact).
// ===========================================================================

export interface MultilineInputProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: (val: string) => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  placeholder?: string;
}

export function MultilineInput({
  value,
  onChange,
  onSubmit,
  onHistoryUp,
  onHistoryDown,
  placeholder,
}: MultilineInputProps) {
  const [cursor, setCursor] = useState(value.length);
  const lastSeenValue = useRef(value);

  // When the parent swaps `value` (history nav, /clear input, etc.) move the
  // cursor to the end so the user starts editing at the tail.
  useEffect(() => {
    if (value !== lastSeenValue.current) {
      lastSeenValue.current = value;
      setCursor(value.length);
    }
  }, [value]);

  const update = (next: string, nextCursor: number) => {
    lastSeenValue.current = next;
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
    onChange(next);
  };

  useInput((input, key) => {
    // ---- Enter handling ------------------------------------------------
    if (key.return) {
      // Shift+Enter (only fires on terminals that report it) → newline
      if (key.shift) {
        insertAtCursor("\n");
        return;
      }
      // Backslash-continuation: trailing `\` before cursor → newline
      if (cursor > 0 && value[cursor - 1] === "\\") {
        const next = value.slice(0, cursor - 1) + "\n" + value.slice(cursor);
        update(next, cursor);
        return;
      }
      onSubmit(value);
      return;
    }

    // Alt+Enter (input='\r') and Ctrl+J / linefeed (input='\n') → newline
    if ((input === "\r" || input === "\n") && !key.return) {
      insertAtCursor("\n");
      return;
    }

    // ---- Editing -------------------------------------------------------
    // Most terminals send \x7f for the Backspace key, which Ink classifies as
    // `key.delete`. Forward-delete (Del key) maps to the same flag, so we
    // can't reliably tell them apart — fold both into "delete previous char",
    // matching the convention of ink-text-input and most Ink apps.
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      update(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }

    // ---- Cursor movement ----------------------------------------------
    if (key.leftArrow) {
      if (cursor > 0) setCursor(cursor - 1);
      return;
    }
    if (key.rightArrow) {
      if (cursor < value.length) setCursor(cursor + 1);
      return;
    }
    if (key.upArrow) {
      const { row, col } = posFromOffset(value, cursor);
      if (row === 0) {
        onHistoryUp?.();
      } else {
        setCursor(offsetFromPos(value, row - 1, col));
      }
      return;
    }
    if (key.downArrow) {
      const { row, col } = posFromOffset(value, cursor);
      const lines = value.split("\n");
      if (row === lines.length - 1) {
        onHistoryDown?.();
      } else {
        setCursor(offsetFromPos(value, row + 1, col));
      }
      return;
    }

    // ---- Emacs-style line shortcuts -----------------------------------
    if (key.ctrl && input === "a") {
      const { row } = posFromOffset(value, cursor);
      setCursor(offsetFromPos(value, row, 0));
      return;
    }
    if (key.ctrl && input === "e") {
      const { row } = posFromOffset(value, cursor);
      setCursor(offsetFromPos(value, row, lineLength(value, row)));
      return;
    }
    if (key.ctrl && input === "u") {
      const { row } = posFromOffset(value, cursor);
      const start = offsetFromPos(value, row, 0);
      update(value.slice(0, start) + value.slice(cursor), start);
      return;
    }
    if (key.ctrl && input === "k") {
      const { row } = posFromOffset(value, cursor);
      const end = offsetFromPos(value, row, lineLength(value, row));
      update(value.slice(0, cursor) + value.slice(end), cursor);
      return;
    }

    // ---- Ignore other control / navigation keys ------------------------
    if (key.escape || key.tab || key.pageUp || key.pageDown) return;

    // ---- Regular character input (incl. multi-char paste) -------------
    if (input && !key.ctrl && !key.meta) {
      // Normalise paste line endings (Windows clipboards send \r\n).
      const normalised = input.replace(/\r\n?/g, "\n");
      insertAtCursor(normalised);
    }
  });

  function insertAtCursor(text: string) {
    const next = value.slice(0, cursor) + text + value.slice(cursor);
    update(next, cursor + text.length);
  }

  // -- Rendering -----------------------------------------------------------
  if (value.length === 0) {
    return (
      <Box>
        <Text inverse> </Text>
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </Box>
    );
  }

  const { row: curRow, col: curCol } = posFromOffset(value, cursor);
  const lines = value.split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <LineRow
          key={i}
          line={line}
          cursorCol={i === curRow ? curCol : null}
        />
      ))}
    </Box>
  );
}

function LineRow({
  line,
  cursorCol,
}: {
  line: string;
  cursorCol: number | null;
}) {
  if (cursorCol === null) {
    return <Text>{line.length === 0 ? " " : line}</Text>;
  }
  const before = line.slice(0, cursorCol);
  const charAtCursor = line[cursorCol] ?? " ";
  const after = line.slice(cursorCol + 1);
  return (
    <Text>
      {before}
      <Text inverse>{charAtCursor}</Text>
      {after}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// helpers — convert between absolute offsets and (row, col) coordinates
// ---------------------------------------------------------------------------

function posFromOffset(
  value: string,
  offset: number,
): { row: number; col: number } {
  let row = 0;
  let col = 0;
  const clamped = Math.max(0, Math.min(offset, value.length));
  for (let i = 0; i < clamped; i++) {
    if (value[i] === "\n") {
      row++;
      col = 0;
    } else {
      col++;
    }
  }
  return { row, col };
}

function offsetFromPos(value: string, row: number, col: number): number {
  const lines = value.split("\n");
  const targetRow = Math.max(0, Math.min(row, lines.length - 1));
  const targetCol = Math.max(0, Math.min(col, lines[targetRow].length));
  let offset = 0;
  for (let i = 0; i < targetRow; i++) {
    offset += lines[i].length + 1;
  }
  return offset + targetCol;
}

function lineLength(value: string, row: number): number {
  const lines = value.split("\n");
  return lines[row]?.length ?? 0;
}
