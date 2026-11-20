import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import TerminalEmulator, { type TerminalEmulatorHandle } from "@/components/terminal-emulator";
import { useAppSettings } from "@/hooks/use-settings";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { toXtermTheme } from "@/utils/to-xterm-theme";
import type { ShellRunState } from "./status";

interface ShellTerminalProps {
  /** Identifies the call. Render with the same React `key` so a new call starts a new view. */
  streamKey: string;
  command: string;
  output: string | undefined;
  /** Where `output` starts in the command's whole output, when its beginning is left out. */
  outputOffset: number | undefined;
  state: ShellRunState;
  /** Fill the parent (sheet) instead of sizing to the output (inline). */
  fill: boolean;
  /** Caps the inline height; longer transcripts scroll inside the view. */
  maxHeight: number | undefined;
}

const ThemedTerminalEmulator = withUnistyles(TerminalEmulator, (theme) => ({
  xtermTheme: toXtermTheme(theme.colors.terminal),
}));

const HIDE_CURSOR = "\x1b[?25l";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const INLINE_MIN_ROWS = 3;
const INLINE_MAX_ROWS = 20;
// xterm draws a row at about 1.2x the font size with lineHeight 1.0.
const ROW_HEIGHT_FACTOR = 1.2;
const TERMINAL_PADDING = 8;
const TERMINAL_DOM_PROPS = { style: { flex: 1 } } as const;
const encoder = new TextEncoder();

// The output was captured from pipes, not a PTY, so bare newlines need a carriage return to
// start the next line at column 0. Lone carriage returns (progress bars) stay as they are.
function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

// The row above the view shows the exit code and duration, so the transcript is the command and
// its output only.
function buildTranscript(command: string, output: string | undefined): string {
  const trimmedCommand = command.replace(/\n+$/, "");
  const trimmedOutput = (output ?? "").replace(/^\n+/, "");
  return toTerminalText(`${HIDE_CURSOR}${DIM}$${RESET} ${trimmedCommand}\n${trimmedOutput}`);
}

// What the view holds of the output: the newest part, enough to tell whether an update follows on.
const WRITTEN_WINDOW_CHARS = 64 * 1024;

interface WrittenOutput {
  command: string;
  /** Where `text` starts in the whole output. */
  start: number;
  text: string;
  /** Output other than leading newlines has been written. */
  started: boolean;
}

// The part of `output` (starting at `start`) past what the view holds, or null when the view
// holds something `output` does not continue.
function outputPastWritten(
  written: WrittenOutput,
  command: string,
  output: string,
  start: number,
): string | null {
  const end = written.start + written.text.length;
  if (command !== written.command || start > end || start + output.length < end) return null;
  const from = Math.max(start, written.start);
  if (output.slice(from - start, end - start) !== written.text.slice(from - written.start)) {
    return null;
  }
  return output.slice(end - start);
}

function keepWritten(input: { command: string; start: number; text: string; started: boolean }) {
  const drop = Math.max(0, input.text.length - WRITTEN_WINDOW_CHARS);
  return { ...input, start: input.start + drop, text: input.text.slice(drop) };
}

// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;
const TAB_WIDTH = 8;

// Rows the transcript takes once xterm soft-wraps it at `cols`. A lone carriage return rewrites
// its line in place, so a line is as wide as its widest segment. Wide (CJK, emoji) glyphs count
// as one cell.
function countWrappedRows(command: string, output: string | undefined, cols: number): number {
  const text = `$ ${command.replace(/\n+$/, "")}\n${(output ?? "").replace(/^\n+/, "")}`;
  let rows = 0;
  for (const line of text.replace(ANSI_SEQUENCE, "").split(/\r?\n/)) {
    let width = 0;
    let lineWidth = 0;
    for (let index = 0; index < line.length; index += 1) {
      const code = line.charCodeAt(index);
      if (code === 13) width = 0;
      else width = code === 9 ? (Math.floor(width / TAB_WIDTH) + 1) * TAB_WIDTH : width + 1;
      if (width > lineWidth) lineWidth = width;
    }
    rows += Math.max(1, Math.ceil(lineWidth / cols));
  }
  return rows;
}

/**
 * A command's output in a read-only terminal, ANSI colors included. Mounted only while a shell
 * row is open. While the command runs, each update appends what is new, so the view tails it.
 */
export function ShellTerminal({
  streamKey,
  command,
  output,
  outputOffset,
  state,
  fill,
  maxHeight,
}: ShellTerminalProps) {
  const { settings } = useAppSettings();
  const emulatorRef = useRef<TerminalEmulatorHandle>(null);
  const writtenRef = useRef<WrittenOutput | null>(null);
  // Columns come from xterm's fit; until the first fit, a line counts as one row.
  const [cols, setCols] = useState<number | null>(null);
  const handleResize = useCallback((input: { cols: number }) => setCols(input.cols), []);

  const isRunning = state === "running";

  // Live output arrives as the newest part of the whole output; only what follows what the view
  // holds is written, so the view keeps its scrollback and position while the command runs.
  useEffect(() => {
    const emulator = emulatorRef.current;
    if (!emulator) return;
    const text = output ?? "";
    const start = outputOffset ?? 0;
    const written = writtenRef.current;
    const past = written ? outputPastWritten(written, command, text, start) : null;
    if (written && past !== null) {
      const shown = written.started ? past : past.replace(/^\n+/, "");
      if (shown.length > 0) emulator.writeOutput(encoder.encode(toTerminalText(shown)));
      writtenRef.current = keepWritten({
        command,
        start: written.start,
        text: written.text + past,
        started: written.started || shown.length > 0,
      });
    } else {
      emulator.clear();
      emulator.writeOutput(encoder.encode(buildTranscript(command, text)));
      writtenRef.current = keepWritten({
        command,
        start,
        text,
        started: /[^\n]/.test(text),
      });
    }
    // A running command tails its output; a finished one opens on the command.
    if (!isRunning) emulator.scrollToTop?.();
  }, [command, output, outputOffset, isRunning]);

  const fontSize = settings.codeFontSize;
  const fontFamily = settings.monoFontFamily.trim() || undefined;
  const rows = useMemo(
    () =>
      isRunning
        ? INLINE_MAX_ROWS
        : Math.min(
            INLINE_MAX_ROWS,
            Math.max(
              INLINE_MIN_ROWS,
              countWrappedRows(command, output, cols ?? Number.POSITIVE_INFINITY),
            ),
          ),
    [isRunning, command, output, cols],
  );
  const contentHeight = Math.ceil(rows * fontSize * ROW_HEIGHT_FACTOR) + TERMINAL_PADDING * 2;
  const inlineHeight = maxHeight === undefined ? contentHeight : Math.min(contentHeight, maxHeight);
  const containerStyle = useMemo(
    () => [styles.container, fill ? styles.fill : inlineUnistylesStyle({ height: inlineHeight })],
    [fill, inlineHeight],
  );

  return (
    <View style={containerStyle} testID="shell-terminal">
      <ThemedTerminalEmulator
        ref={emulatorRef}
        dom={TERMINAL_DOM_PROPS}
        streamKey={streamKey}
        testId="shell-terminal-surface"
        readOnly
        scrollbackLines={settings.terminalScrollbackLines}
        fontFamily={fontFamily}
        fontSize={fontSize}
        onResize={handleResize}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    padding: TERMINAL_PADDING,
    borderRadius: theme.borderRadius.xl,
    overflow: "hidden",
    backgroundColor: theme.colors.terminal.background,
  },
  fill: {
    flex: 1,
    minHeight: 0,
  },
}));
