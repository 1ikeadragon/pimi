import type { TFunction } from "i18next";
import { buildToolCallPresentation } from "@/tool-calls/presentation";
import { describeToolCall, type GroupableItem } from "@/tool-calls/detail-level/grouping";
import type { StreamItem } from "@/types/stream";

export type WorkingStatusKind = "working" | "waiting";

export interface WorkingStatus {
  kind: WorkingStatusKind;
  label: string;
  /** Names what the agent is doing right now; false for the generic "Working" fallback. */
  specific: boolean;
  /** Applies at once, bypassing the line's dwell time and sticky label. */
  urgent: boolean;
}

export interface ResolveWorkingStatusInput {
  isCancelling: boolean;
  hasPendingPermission: boolean;
  agentStatus: string;
  providerLabel: string;
  /** Null while only the submission is pending and the server has not opened the turn. */
  turnStartedAt: Date | null;
  /** Newest stream item (head, else tail). Tool calls land in the tail, so both lanes matter. */
  latest: StreamItem | undefined;
  /** Id of the open turn; keeps a finished turn's last item from describing this one. */
  activeTurnId: string | null;
  cwd?: string;
  t: TFunction;
}

const noIcon = () => () => null;

function working(label: string, specific: boolean): WorkingStatus {
  return { kind: "working", label, specific, urgent: false };
}

function toolCallLabel(item: Extract<StreamItem, { kind: "tool_call" }>, cwd?: string): string {
  if (item.payload.source !== "agent") {
    return item.payload.data.toolName;
  }
  const data = item.payload.data;
  // Same wording as the tool row so the status line and the row above it never disagree.
  const presentation = buildToolCallPresentation({
    toolName: data.name,
    agentMessage: data.agentMessage,
    status: data.status,
    error: data.error,
    detail: data.detail,
    metadata: data.metadata,
    cwd,
    resolveIcon: noIcon,
  });
  return presentation.summary
    ? `${presentation.displayName} ${presentation.summary}`
    : presentation.displayName;
}

export function resolveWorkingStatus(input: ResolveWorkingStatusInput): WorkingStatus {
  const { t } = input;
  if (input.isCancelling) {
    return {
      kind: "working",
      label: t("agentStream.working.stopping"),
      specific: true,
      urgent: true,
    };
  }
  if (input.hasPendingPermission) {
    return {
      kind: "waiting",
      label: t("agentStream.working.waitingApproval"),
      specific: true,
      urgent: true,
    };
  }
  if (input.agentStatus === "initializing") {
    return working(t("agentStream.working.starting", { provider: input.providerLabel }), true);
  }
  if (input.turnStartedAt === null) {
    return working(t("agentStream.working.sending"), true);
  }

  const last = input.latest;
  if (last && last.kind !== "tool_call" && last.turnId !== input.activeTurnId) {
    return working(t("agentStream.working.working"), false);
  }
  if (last?.kind === "tool_call") {
    const running =
      last.payload.data.status === "running" || last.payload.data.status === "executing";
    if (running) {
      return working(toolCallLabel(last, input.cwd), true);
    }
  } else if (last?.kind === "thought" && last.status === "loading") {
    return working(t("agentStream.working.thinking"), true);
  } else if (last?.kind === "assistant_message") {
    return working(t("agentStream.working.writing"), true);
  } else if (last?.kind === "compaction" && last.status === "loading") {
    return working(t("agentStream.working.compacting"), true);
  }
  return working(t("agentStream.working.working"), false);
}

export interface LiveRunSummary {
  stepCount: number;
  failedCount: number;
}

/** What the status line counts of the run it owns: every call and thought, and the failed calls. */
export function summarizeLiveRun(calls: readonly GroupableItem[]): LiveRunSummary {
  let failedCount = 0;
  for (const call of calls) {
    if (call.kind === "tool_call" && describeToolCall(call).status === "failed") failedCount += 1;
  }
  return { stepCount: calls.length, failedCount };
}
