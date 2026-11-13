import type { AgentMessage } from "@pimi/protocol/agent-message";
import { buildAgentMessageDisplay } from "@pimi/protocol/pimi-tool-presentation/index";
import type { PlanOutcome } from "@/components/plan-card";
import type { ComponentType } from "react";
import type { TFunction } from "i18next";
import type { ToolCallDetail } from "@pimi/protocol/agent-types";
import { isPimiToolName } from "@pimi/protocol/tool-name-normalization";
import { readToolBodyOmitted } from "@pimi/protocol/tool-call-body";
import { buildLineDiff, parseUnifiedDiff } from "@/utils/tool-call-parsers";
import type { ToolCallDisplayInput } from "@/utils/tool-call-display";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";
import { extractToolCallFilePath } from "@/utils/extract-tool-call-file-path";
import {
  hasMeaningfulToolCallDetail,
  isPendingToolCallDetail,
} from "@/utils/tool-call-detail-state";

type ToolCallStatus = "executing" | "running" | "completed" | "failed" | "canceled";
export type ToolCallPresentationIcon = ComponentType<{ size?: number; color?: string }>;

interface BuildToolCallPresentationInput {
  agentMessage?: AgentMessage;
  toolName: string;
  status: ToolCallStatus;
  error: unknown;
  detail?: ToolCallDetail;
  cwd?: string;
  metadata?: Record<string, unknown>;
  targetAgentTitle?: string;
  resolveIcon: ToolCallIconResolver;
  t: TFunction;
}

type ActivityVerbKey = "read" | "search" | "fetch" | "edit" | "write" | "shell" | "thinking";

export interface ToolCallPresentation {
  detail: ToolCallDetail | undefined;
  displayName: string;
  summary?: string;
  /** The row's lead word, in the present participle while the call runs: "Read", "Running". */
  verb: string;
  /** What the verb acted on; the row's second text. */
  target?: string;
  targetMono: boolean;
  diffStat?: { additions: number; deletions: number };
  errorText?: string;
  icon: ToolCallPresentationIcon;
  isLoadingDetails: boolean;
  hasDetails: boolean;
  canOpenDetails: boolean;
  openFilePath: string | null;
  isPlan: boolean;
  planOutcome?: PlanOutcome;
}

export type ToolCallIconResolver = (
  toolName: string,
  detail: ToolCallDetail | undefined,
  agentMessage: AgentMessage | undefined,
) => ToolCallPresentationIcon;

function resolveVerbKey(
  toolName: string,
  detail: ToolCallDetail | undefined,
  isPimiCall: boolean,
): ActivityVerbKey | null {
  if (isPimiCall) return null;
  if (toolName.trim().toLowerCase() === "thinking" && (!detail || detail.type === "unknown")) {
    return "thinking";
  }
  switch (detail?.type) {
    case "read":
    case "search":
    case "fetch":
    case "edit":
    case "write":
    case "shell":
      return detail.type;
    default:
      return null;
  }
}

// The line diff is quadratic in line count; past this many comparisons the row counts every line
// of both sides as changed, an upper bound, rather than stall the timeline on a huge rewrite.
const DIFF_STAT_MAX_COMPARISONS = 250_000;

function countLines(text: string | undefined): number {
  if (!text) return 0;
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

function countChangedLines(lines: readonly { type: string }[]) {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === "add") additions += 1;
    else if (line.type === "remove") deletions += 1;
  }
  return { additions, deletions };
}

function countEditChange(detail: Extract<ToolCallDetail, { type: "edit" }>) {
  if (detail.unifiedDiff) return countChangedLines(parseUnifiedDiff(detail.unifiedDiff));
  const oldLines = countLines(detail.oldString);
  const newLines = countLines(detail.newString);
  if (oldLines * newLines > DIFF_STAT_MAX_COMPARISONS) {
    return { additions: newLines, deletions: oldLines };
  }
  return countChangedLines(buildLineDiff(detail.oldString ?? "", detail.newString ?? ""));
}

function computeDiffStat(
  detail: ToolCallDetail | undefined,
  bodyOmitted: boolean,
): { additions: number; deletions: number } | undefined {
  // A cut body would count the preview, not the change.
  if (bodyOmitted || !detail) return undefined;
  let change: { additions: number; deletions: number };
  if (detail.type === "write") change = { additions: countLines(detail.content), deletions: 0 };
  else if (detail.type === "edit") change = countEditChange(detail);
  else return undefined;
  return change.additions + change.deletions > 0 ? change : undefined;
}

function displayStatus(status: ToolCallStatus): ToolCallDisplayInput["status"] {
  return status === "executing" ? "running" : status;
}

function displayDetail(detail: ToolCallDetail | undefined): ToolCallDetail {
  return detail ?? { type: "unknown", input: null, output: null };
}

export function buildToolCallPresentation(
  input: BuildToolCallPresentationInput,
): ToolCallPresentation {
  const detail = input.agentMessage
    ? buildAgentMessageDisplay(input.agentMessage).detail
    : input.detail;
  const detailForDisplay = displayDetail(detail);
  const displayModel = buildToolCallDisplayModel({
    name: input.toolName,
    agentMessage: input.agentMessage,
    status: displayStatus(input.status),
    error: input.error ?? null,
    detail: detailForDisplay,
    metadata: input.metadata,
    cwd: input.cwd,
    targetAgentTitle: input.targetAgentTitle,
  });
  const isLoadingDetails = isPendingToolCallDetail({
    detail,
    status: input.status,
    error: input.error,
  });
  const hasDetails = Boolean(input.error) || hasMeaningfulToolCallDetail(detail);
  const isRunning = input.status === "running" || input.status === "executing";
  const verbKey = resolveVerbKey(
    input.toolName,
    detail,
    Boolean(input.agentMessage) || isPimiToolName(input.toolName),
  );
  const verb = verbKey
    ? input.t(`activity.verbs.${verbKey}.${isRunning ? "running" : "done"}`)
    : displayModel.displayName;
  const target =
    verbKey === "shell" ? displayModel.summary?.replace(/\s+/g, " ") : displayModel.summary;
  const bodyOmitted = readToolBodyOmitted(input.metadata) > 0;

  return {
    detail,
    displayName: displayModel.displayName,
    summary: displayModel.summary,
    verb,
    target: verbKey === "thinking" ? undefined : target,
    targetMono: verbKey === "shell",
    diffStat: computeDiffStat(detail, bodyOmitted),
    errorText: displayModel.errorText,
    icon: input.resolveIcon(input.toolName, detail, input.agentMessage),
    isLoadingDetails,
    hasDetails,
    canOpenDetails: hasDetails || isLoadingDetails,
    openFilePath: extractToolCallFilePath(detail),
    isPlan: input.detail?.type === "plan",
    planOutcome: input.detail?.type === "plan" ? resolvePlanOutcome(input) : undefined,
  };
}

function resolvePlanOutcome(input: BuildToolCallPresentationInput): PlanOutcome | undefined {
  if (input.status === "canceled") return "canceled";
  if (input.metadata?.approved === false) return "rejected";
  if (input.metadata?.approved === true) return "approved";
  if (input.status === "running" || input.status === "executing") return "pending";
  return undefined;
}
