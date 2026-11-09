import { ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT } from "./assistant-message-render-limit.shared";
import type { CappedAssistantMessage } from "./assistant-message-render-limit.shared";
export {
  getUtf8ByteLength,
  ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT,
  type CappedAssistantMessage,
} from "./assistant-message-render-limit.shared";

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function capAssistantMessageForRender(message: string): CappedAssistantMessage {
  if (message.length <= ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT) {
    return { text: message, capped: false };
  }

  let end = ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT;
  if (graphemeSegmenter) {
    end = graphemeSegmenter.segment(message).containing(end)!.index;
  } else {
    const finalCodeUnit = message.charCodeAt(end - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
      end -= 1;
    }
  }

  return { text: message.slice(0, end), capped: true };
}
