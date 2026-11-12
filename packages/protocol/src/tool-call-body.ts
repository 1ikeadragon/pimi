import type { AgentTimelineItem, ToolCallDetail } from "./agent-types.js";

/**
 * History pages sent to the app carry a short preview of each large tool-call body instead of the
 * body. The row's `metadata[TOOL_BODY_BYTES_METADATA_KEY]` holds the UTF-16 length of what was cut,
 * and the app fetches the full detail with `agent.timeline.get_tool_body.request` when the user
 * expands the call. A body at or under the preview limit stays whole and sets no marker.
 */
export const TOOL_BODY_BYTES_METADATA_KEY = "pimiBodyOmitted";
export const TOOL_BODY_PREVIEW_CHARS = 2000;
export const TOOL_BODY_PREVIEW_LINES = 20;

type ToolCallTimelineItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

export function readToolBodyOmitted(metadata: Record<string, unknown> | undefined): number {
  const value = metadata?.[TOOL_BODY_BYTES_METADATA_KEY];
  return typeof value === "number" && value > 0 ? value : 0;
}

function previewOf(text: string): string {
  let end = Math.min(text.length, TOOL_BODY_PREVIEW_CHARS);
  let newlines = 0;
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 10 && ++newlines === TOOL_BODY_PREVIEW_LINES) {
      end = i;
      break;
    }
  }
  // Do not end on half a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

class Omitted {
  chars = 0;
  cut(text: string | undefined): string | undefined {
    if (text === undefined || text.length <= TOOL_BODY_PREVIEW_CHARS) return text;
    const preview = previewOf(text);
    this.chars += text.length - preview.length;
    return preview;
  }
}

function stripDetail(detail: ToolCallDetail, omitted: Omitted): ToolCallDetail {
  switch (detail.type) {
    case "shell":
      return { ...detail, output: omitted.cut(detail.output) };
    case "read":
    case "write":
    case "search":
      return { ...detail, content: omitted.cut(detail.content) };
    case "edit":
      return {
        ...detail,
        oldString: omitted.cut(detail.oldString),
        newString: omitted.cut(detail.newString),
        unifiedDiff: omitted.cut(detail.unifiedDiff),
      };
    case "fetch":
      return { ...detail, result: omitted.cut(detail.result) };
    case "worktree_setup":
      return {
        ...detail,
        commands: detail.commands.map((command) => ({
          ...command,
          log: omitted.cut(command.log) ?? "",
        })),
      };
    // `unknown` and `plain_text` bodies carry structured results (task proposals, delegation) that
    // the app reads directly, so they stay whole.
    case "unknown":
    case "plain_text":
    case "sub_agent":
    case "plan":
      return detail;
  }
}

/** Returns the item itself when no body is long enough to cut. */
export function stripToolCallBodies(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "tool_call") return item;
  const omitted = new Omitted();
  const detail = stripDetail(item.detail, omitted);
  if (omitted.chars === 0) return item;
  const stripped: ToolCallTimelineItem = {
    ...item,
    detail,
    metadata: { ...item.metadata, [TOOL_BODY_BYTES_METADATA_KEY]: omitted.chars },
  };
  return stripped;
}
