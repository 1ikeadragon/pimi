import { useMemo } from "react";
import { useAgentTileStream } from "@/hooks/use-agent-tile-stream";
import { isAgentToolCallItem, type StreamItem } from "@/types/stream";

// Feed limits from the subview plan: 20 shell calls per agent, 40 lines per pane, one line cut at
// 400 characters so a minified bundle cannot make the pane expensive.
const MAX_CALLS = 20;
const MAX_LINES = 40;
const MAX_LINE_CHARS = 400;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export interface AttackShellLine {
  key: string;
  kind: "command" | "output" | "status";
  text: string;
}

export interface AttackShellFeed {
  lines: AttackShellLine[];
  callCount: number;
  running: boolean;
}

function clean(text: string): string {
  const stripped = text.replace(ANSI, "").replace(/\r/g, "");
  return stripped.length > MAX_LINE_CHARS ? `${stripped.slice(0, MAX_LINE_CHARS)}…` : stripped;
}

/** The last shell tool calls in a timeline, flattened to the last `MAX_LINES` display lines. */
export function buildShellFeed(items: readonly StreamItem[]): AttackShellFeed {
  const calls: Array<{
    id: string;
    command: string;
    output?: string;
    exit?: number | null;
    running: boolean;
  }> = [];
  // Newest first, stopping as soon as the cap is met, so the scan stays small on long timelines.
  for (let index = items.length - 1; index >= 0 && calls.length < MAX_CALLS; index -= 1) {
    const item = items[index];
    if (!item || !isAgentToolCallItem(item)) continue;
    const { detail, status } = item.payload.data;
    if (detail.type !== "shell") continue;
    calls.push({
      id: item.id,
      command: detail.command,
      output: detail.output,
      exit: detail.exitCode,
      running: status === "running",
    });
  }
  calls.reverse();
  const lines: AttackShellLine[] = [];
  for (const call of calls) {
    lines.push({
      key: `${call.id}:c`,
      kind: "command",
      text: clean(call.command.split("\n")[0] ?? ""),
    });
    if (call.output) {
      const outputLines = call.output.split("\n");
      // Only the tail of an output can reach the pane, so earlier lines are never cleaned.
      const tail = outputLines.slice(-MAX_LINES);
      tail.forEach((text, i) => {
        if (text.length > 0 || i < tail.length - 1) {
          lines.push({ key: `${call.id}:o${i}`, kind: "output", text: clean(text) });
        }
      });
    }
    if (typeof call.exit === "number" && call.exit !== 0) {
      lines.push({ key: `${call.id}:x`, kind: "status", text: `exit ${call.exit}` });
    }
  }
  return {
    lines: lines.slice(-MAX_LINES),
    callCount: calls.length,
    running: calls.at(-1)?.running ?? false,
  };
}

/**
 * One agent's shell activity, read from the timeline the board already loads. Timeline demand is
 * held only while `visible`, so a pane on another page pulls nothing.
 */
export function useAttackShellFeed(
  serverId: string,
  agentId: string,
  visible: boolean,
): AttackShellFeed {
  const { items } = useAgentTileStream(serverId, agentId, visible);
  return useMemo(() => buildShellFeed(items), [items]);
}
