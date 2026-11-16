import { fromMarkdown } from "mdast-util-from-markdown";
import { ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT } from "./assistant-message-render-limit.shared";
import type { CappedAssistantMessage } from "./assistant-message-render-limit.shared";
export {
  ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT,
  type CappedAssistantMessage,
} from "./assistant-message-render-limit.shared";

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemeBoundary(message: string, index: number): number {
  if (graphemeSegmenter) return graphemeSegmenter.segment(message).containing(index)!.index;
  const finalCodeUnit = message.charCodeAt(index - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? index - 1 : index;
}

/**
 * The cap bounds Markdown node fan-out. A `pimi-*` visual block renders as one card, so its body
 * doesn't count; the cut lands in prose, never inside a visual block.
 */
function cutOffset(message: string): number | null {
  let budget = ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT;
  let cursor = 0;
  for (const node of fromMarkdown(message).children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const isVisual = node.type === "code" && node.lang?.toLowerCase().startsWith("pimi-");
    const cost = isVisual ? start - cursor : end - cursor;
    if (cost > budget) return cursor + budget;
    budget -= cost;
    cursor = end;
  }
  return message.length - cursor > budget ? cursor + budget : null;
}

export function capAssistantMessageForRender(message: string): CappedAssistantMessage {
  if (message.length <= ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT) {
    return { text: message, capped: false };
  }
  const end = cutOffset(message);
  if (end === null) return { text: message, capped: false };
  return { text: message.slice(0, graphemeBoundary(message, end)), capped: true };
}
