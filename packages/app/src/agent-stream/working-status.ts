import type { TFunction } from "i18next";
import { buildToolCallPresentation } from "@/tool-calls/presentation";
import type { StreamItem } from "@/types/stream";

export type WorkingStatusKind = "working" | "waiting";

export interface WorkingStatus {
  kind: WorkingStatusKind;
  label: string;
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
    return { kind: "working", label: t("agentStream.working.stopping") };
  }
  if (input.hasPendingPermission) {
    return { kind: "waiting", label: t("agentStream.working.waitingApproval") };
  }
  if (input.agentStatus === "initializing") {
    return {
      kind: "working",
      label: t("agentStream.working.starting", { provider: input.providerLabel }),
    };
  }
  if (input.turnStartedAt === null) {
    return { kind: "working", label: t("agentStream.working.sending") };
  }

  const last = input.latest;
  if (last && last.kind !== "tool_call" && last.turnId !== input.activeTurnId) {
    return { kind: "working", label: t("agentStream.working.working") };
  }
  if (last?.kind === "tool_call") {
    const running =
      last.payload.data.status === "running" || last.payload.data.status === "executing";
    if (running) {
      return { kind: "working", label: toolCallLabel(last, input.cwd) };
    }
  } else if (last?.kind === "thought" && last.status === "loading") {
    return { kind: "working", label: t("agentStream.working.thinking") };
  } else if (last?.kind === "assistant_message") {
    return { kind: "working", label: t("agentStream.working.writing") };
  } else if (last?.kind === "compaction" && last.status === "loading") {
    return { kind: "working", label: t("agentStream.working.compacting") };
  }
  return { kind: "working", label: t("agentStream.working.working") };
}
