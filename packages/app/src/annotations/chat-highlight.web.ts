// Adapted from T3 Code apps/web/src/components/chat/AssistantCitationSource.tsx (MIT, © 2026 T3 Tools Inc.).
import { findMessageRows } from "@/agent-stream/chat-find/ranges.web";
import type { AnnotationTextSelector } from "./model";
import { ANNOTATION_HIGHLIGHT_NAME } from "./popover.web";
import { resolveSelectorRange } from "./text-selector.web";

/** The text blocks of one message, across every row it is rendered in. */
export function messageContents(root: HTMLElement, messageId: string): HTMLElement[] {
  return findMessageRows(root, messageId).flatMap((row) =>
    Array.from(row.querySelectorAll<HTMLElement>('[data-message-text="true"]')),
  );
}

function highlightRegistry(): HighlightRegistry | null {
  const supported =
    typeof Highlight !== "undefined" && typeof CSS !== "undefined" && "highlights" in CSS;
  return supported ? CSS.highlights : null;
}

/**
 * Highlights `range` and keeps it on the quote while the message re-renders under it, as it does
 * when streaming or when the list recycles its rows. `range` is repaired in place, so anything
 * anchored to it follows. Calls `onUnavailable` once the quote is no longer rendered.
 */
export function observeChatHighlight(input: {
  root: HTMLElement;
  messageId: string;
  selector: AnnotationTextSelector;
  range: Range;
  onUnavailable(): void;
}): () => void {
  const { root, messageId, selector, range, onUnavailable } = input;
  const registry = highlightRegistry();
  let highlight: Highlight | null = null;
  let stopped = false;
  let frame = 0;

  function dispose() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    if (!highlight || !registry) return;
    highlight.delete(range);
    if (highlight.size === 0 && registry.get(ANNOTATION_HIGHLIGHT_NAME) === highlight) {
      registry.delete(ANNOTATION_HIGHLIGHT_NAME);
    }
  }
  function repair() {
    if (stopped) return;
    const repaired = resolveSelectorRange(messageContents(root, messageId), selector);
    if (!repaired) {
      dispose();
      onUnavailable();
      return;
    }
    range.setStart(repaired.startContainer, repaired.startOffset);
    range.setEnd(repaired.endContainer, repaired.endOffset);
  }
  const observer = new MutationObserver((records) => {
    const rows = findMessageRows(root, messageId);
    const detached =
      range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected;
    const sourceChanged = records.some((record) => rows.some((row) => row.contains(record.target)));
    if (!detached && !sourceChanged) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(repair);
  });

  if (registry) {
    const existing = registry.get(ANNOTATION_HIGHLIGHT_NAME);
    highlight = existing ?? new Highlight();
    highlight.add(range);
    if (!existing) registry.set(ANNOTATION_HIGHLIGHT_NAME, highlight);
  }
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return dispose;
}
