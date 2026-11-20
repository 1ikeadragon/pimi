import { useEffect, useMemo, useRef } from "react";
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
  state: ShellRunState;
  /** Fill the parent (sheet) instead of sizing to the output (inline). */
  fill: boolean;
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

function countRows(text: string): number {
  let rows = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) rows += 1;
  }
  return rows;
}

/**
 * A command's output in a read-only terminal, ANSI colors included. Mounted only while a shell
 * row is open. While the command runs, each update appends what is new, so the view tails it.
 */
export function ShellTerminal({ streamKey, command, output, state, fill }: ShellTerminalProps) {
  const { settings } = useAppSettings();
  const emulatorRef = useRef<TerminalEmulatorHandle>(null);
  const writtenRef = useRef("");

  const transcript = useMemo(() => buildTranscript(command, output), [command, output]);

  useEffect(() => {
    const emulator = emulatorRef.current;
    if (!emulator) return;
    const written = writtenRef.current;
    if (transcript.startsWith(written)) {
      emulator.writeOutput(encoder.encode(transcript.slice(written.length)));
    } else {
      emulator.clear();
      emulator.writeOutput(encoder.encode(transcript));
    }
    writtenRef.current = transcript;
  }, [transcript]);

  const fontSize = settings.codeFontSize;
  const fontFamily = settings.monoFontFamily.trim() || undefined;
  const rows =
    state === "running"
      ? INLINE_MAX_ROWS
      : Math.min(INLINE_MAX_ROWS, Math.max(INLINE_MIN_ROWS, countRows(transcript)));
  const inlineHeight = Math.ceil(rows * fontSize * ROW_HEIGHT_FACTOR) + TERMINAL_PADDING * 2;
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
