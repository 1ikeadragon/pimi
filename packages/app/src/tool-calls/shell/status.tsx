import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ToolCallDetail } from "@pimi/protocol/agent-types";
import { readToolCallStartedAt } from "@pimi/protocol/tool-call-timing";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useTranslation } from "@/i18n/use-translation";
import { formatDuration } from "@/utils/time";

export type ShellRunState = "running" | "completed" | "failed" | "canceled";

interface ShellStatusProps {
  state: ShellRunState;
  exitCode: number | null | undefined;
  startedAtMs: number;
  endedAtMs: number;
}

// A command that finished inside a second shows no duration; "0s" says nothing.
const MIN_SHOWN_DURATION_MS = 1000;

function readStartedAtMs(metadata: Record<string, unknown> | undefined): number | null {
  const startedAt = readToolCallStartedAt(metadata);
  if (startedAt === null) return null;
  const ms = Date.parse(startedAt);
  return Number.isNaN(ms) ? null : ms;
}

/** The trailing status of a tool call row when the call is a shell command. */
export function useShellRowStatus(input: {
  detail: ToolCallDetail | undefined;
  state: ShellRunState;
  /** The row's newest update, in ms. */
  timestamp: number | undefined;
  metadata: Record<string, unknown> | undefined;
}): ReactNode {
  const { detail, state, timestamp, metadata } = input;
  const isShell = detail?.type === "shell";
  const exitCode = isShell ? detail.exitCode : undefined;
  return useMemo(() => {
    if (!isShell || timestamp === undefined) return undefined;
    return (
      <ShellStatus
        state={state}
        exitCode={exitCode}
        startedAtMs={readStartedAtMs(metadata) ?? timestamp}
        endedAtMs={timestamp}
      />
    );
  }, [isShell, exitCode, state, timestamp, metadata]);
}

/** A shell row's trailing text: elapsed time while it runs, exit code and duration after. */
export const ShellStatus = memo(function ShellStatus({
  state,
  exitCode,
  startedAtMs,
  endedAtMs,
}: ShellStatusProps) {
  if (state === "running") return <RunningElapsed startedAtMs={startedAtMs} />;
  return (
    <FinishedStatus
      state={state}
      exitCode={exitCode}
      durationMs={Math.max(0, endedAtMs - startedAtMs)}
    />
  );
});

function RunningElapsed({ startedAtMs }: { startedAtMs: number }) {
  const panelActive = useRetainedPanelActive();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!panelActive) return undefined;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [panelActive]);
  return (
    <Text style={styles.text} numberOfLines={1} testID="shell-status">
      {formatDuration(Math.max(0, now - startedAtMs))}
    </Text>
  );
}

function FinishedStatus({
  state,
  exitCode,
  durationMs,
}: {
  state: Exclude<ShellRunState, "running">;
  exitCode: number | null | undefined;
  durationMs: number;
}) {
  const { t } = useTranslation();
  const hasExitCode = typeof exitCode === "number";
  const isError = state === "failed" || (hasExitCode && exitCode !== 0);
  const parts: string[] = [];
  if (state === "canceled") parts.push(t("activity.stopped"));
  else if (hasExitCode && exitCode !== 0) parts.push(t("activity.exitCode", { code: exitCode }));
  else if (state === "failed") parts.push(t("activity.failed"));
  if (durationMs >= MIN_SHOWN_DURATION_MS) parts.push(formatDuration(durationMs));
  if (parts.length === 0) return null;
  return (
    <Text style={[styles.text, isError && styles.error]} numberOfLines={1} testID="shell-status">
      {parts.join(" · ")}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  error: {
    color: theme.colors.statusDanger,
  },
}));
