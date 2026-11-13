import type { AgentMessage } from "@pimi/protocol/agent-message";
import type { ToolCallDetail, ToolCallIconName } from "@pimi/protocol/agent-types";
import { isPimiToolName } from "@pimi/protocol/tool-name-normalization";

export type ToolCallIcon =
  | ToolCallIconName
  | "pimi"
  | "file_text"
  | "file_pen_line"
  | "globe"
  | "plug";

const TOOL_DETAIL_ICON_NAMES: Record<ToolCallDetail["type"], ToolCallIcon> = {
  shell: "square_terminal",
  read: "file_text",
  edit: "file_pen_line",
  write: "file_pen_line",
  search: "search",
  fetch: "globe",
  worktree_setup: "square_terminal",
  sub_agent: "bot",
  plain_text: "wrench",
  plan: "brain",
  unknown: "wrench",
};

function isMcpToolName(lowerName: string): boolean {
  return lowerName.startsWith("mcp__");
}

export function resolveToolCallIconName(
  toolName: string,
  detail?: ToolCallDetail,
  agentMessage?: AgentMessage,
): ToolCallIcon {
  // Agent messages are Pimi deliveries; the wire detail's legacy "bot" icon is for old clients.
  if (agentMessage) {
    return "pimi";
  }
  const lowerName = toolName.trim().toLowerCase();

  if (detail?.type === "plain_text" && detail.icon) {
    return detail.icon;
  }

  // Thoughts are rendered through ToolCall with unknown detail payloads.
  if (lowerName === "thinking" && (!detail || detail.type === "unknown")) {
    return "brain";
  }
  if (lowerName === "speak") {
    return "mic_vocal";
  }
  if (isPimiToolName(lowerName)) {
    return "pimi";
  }
  if (lowerName === "task") {
    return "bot";
  }
  if (isMcpToolName(lowerName)) {
    return "plug";
  }

  if (detail?.type === "search" && detail.toolName === "web_search") {
    return "globe";
  }
  if (detail) {
    return TOOL_DETAIL_ICON_NAMES[detail.type];
  }
  return "wrench";
}
