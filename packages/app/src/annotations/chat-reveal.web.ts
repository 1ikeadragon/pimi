// Adapted from T3 Code apps/web/src/components/chat/AssistantCitationSource.tsx (MIT, © 2026 T3 Tools Inc.).
import { findMessageRows } from "@/agent-stream/chat-find/ranges.web";
import type { ChatFindProps } from "@/agent-stream/chat-find/types";
import { PROMPT_JUMP_TOP_INSET_PX } from "@/agent-stream/prompt-jump-settle";
import { messageContents } from "./chat-highlight.web";
import type { AnnotationTextSelector } from "./model";
import { ANNOTATION_SOURCE_TOP_OFFSET_PX, prefersReducedMotion } from "./pulse.web";
import { playQuotePulse } from "./pulse-overlay.web";
import { resolveSelectorRange } from "./text-selector.web";

/** Rows of a long message mount over a few frames before the quote can be found in them. */
const QUOTE_SEARCH_FRAMES = 10;
const SETTLED_FRAMES = 3;
const LOCATE_TIMEOUT_MS = 5000;

/** How the chat moves to a message; chat find and the chat outline use the same bindings. */
export type ChatNavigation = Pick<
  ChatFindProps,
  "viewportRef" | "revealLoadedMessage" | "visibleMessageIds"
>;

/** `unreachable`: the message is not loaded or could not be scrolled to. */
export type ChatRevealNotice = "unreachable" | "quoteChanged";

let current: (() => void) | null = null;

function scrollParent(element: Element): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight)
      return node;
  }
  return null;
}

function renderedRows(root: HTMLElement, messageId: string): HTMLElement[] {
  return findMessageRows(root, messageId).filter((row) => row.getBoundingClientRect().height > 0);
}

/**
 * Scrolls the chat until the quote sits near its top, then pulses the quote and fades it out.
 * Only one quote pulses at a time. The user scrolling before the chat lands cancels quietly;
 * `onNotice` reports a message that cannot be reached or no longer holds the quote. `onDone`
 * runs once the reveal ends by itself, not when the returned function disposes it.
 */
export function revealChatQuote(input: {
  root: HTMLElement;
  messageId: string;
  selector: AnnotationTextSelector;
  getNavigation(): ChatNavigation | null;
  onNotice(notice: ChatRevealNotice): void;
  onDone(): void;
}): () => void {
  const { root, messageId, selector, getNavigation, onNotice, onDone } = input;
  current?.();
  const reducedMotion = prefersReducedMotion();
  const scrollAbort = new AbortController();
  const deadline = performance.now() + LOCATE_TIMEOUT_MS;
  let frame = 0;
  let stopped = false;
  let scrolledToMessage = false;
  let scrolledToQuote = false;
  let missingFrames = 0;
  let settledFrames = 0;
  let lastTop: number | null = null;
  let range: Range | null = null;
  let stopPulse: (() => void) | null = null;

  const resolve = () => resolveSelectorRange(messageContents(root, messageId), selector);

  function dispose() {
    if (stopped) return;
    stopped = true;
    if (current === dispose) current = null;
    cancelAnimationFrame(frame);
    scrollAbort.abort();
    stopListeningForIntent();
    observer.disconnect();
    stopPulse?.();
  }
  function finish(notice?: ChatRevealNotice) {
    if (stopped) return;
    dispose();
    if (notice) onNotice(notice);
    onDone();
  }
  function scrollToMessage(navigation: ChatNavigation) {
    if (scrolledToMessage) return;
    scrolledToMessage = true;
    navigation.viewportRef.current?.scrollToMessage?.(messageId);
  }

  // The settle loop stops on a wheel or key; the reveal stops with it instead of pulsing later.
  const userScrolled = () => {
    if (!stopPulse) finish();
  };
  root.addEventListener("wheel", userScrolled, { passive: true });
  root.addEventListener("touchstart", userScrolled, { passive: true });
  function stopListeningForIntent() {
    root.removeEventListener("wheel", userScrolled);
    root.removeEventListener("touchstart", userScrolled);
  }

  function locate() {
    frame = 0;
    if (stopped) return;
    if (performance.now() >= deadline) {
      finish("unreachable");
      return;
    }
    const navigation = getNavigation();
    if (!navigation) {
      finish("unreachable");
      return;
    }
    // A message older than the rendered window is loaded into it first, or opened out of a
    // collapsed turn.
    if (!navigation.visibleMessageIds.has(messageId)) {
      if (!navigation.revealLoadedMessage(messageId)) {
        finish("unreachable");
        return;
      }
      frame = requestAnimationFrame(locate);
      return;
    }
    const rows = renderedRows(root, messageId);
    if (rows.length === 0 || rows.some((row) => row.querySelector('[aria-busy="true"]'))) {
      // The list has not rendered the message; bring its rows into the window.
      scrollToMessage(navigation);
      frame = requestAnimationFrame(locate);
      return;
    }
    const found = resolve();
    if (!found) {
      if (++missingFrames < QUOTE_SEARCH_FRAMES) {
        frame = requestAnimationFrame(locate);
        return;
      }
      scrollToMessage(navigation);
      finish("quoteChanged");
      return;
    }
    if (!scrolledToQuote) {
      scrolledToQuote = true;
      navigation.viewportRef.current?.scrollToMessage?.(messageId, {
        signal: scrollAbort.signal,
        smooth: true,
        targetTop() {
          const quote = resolve();
          if (!quote) return null;
          const scroller = scrollParent(rows[0]!);
          const offset = Math.min(
            ANNOTATION_SOURCE_TOP_OFFSET_PX,
            (scroller?.clientHeight ?? 0) / 3,
          );
          return quote.getBoundingClientRect().top - offset + PROMPT_JUMP_TOP_INSET_PX;
        },
      });
    }
    // Pulse once the quote has stopped moving inside the visible chat.
    const rect = found.getBoundingClientRect();
    const scroller = scrollParent(rows[0]!);
    const bounds = scroller?.getBoundingClientRect();
    const visible = !bounds || (rect.bottom > bounds.top && rect.top < bounds.bottom);
    settledFrames = lastTop !== null && Math.abs(rect.top - lastTop) < 1 ? settledFrames + 1 : 0;
    lastTop = rect.top;
    if (!visible || settledFrames < SETTLED_FRAMES) {
      frame = requestAnimationFrame(locate);
      return;
    }
    pulse(found);
  }

  function pulse(found: Range) {
    stopListeningForIntent();
    range = found;
    stopPulse = playQuotePulse({ range: found, reducedMotion, onDone: finish });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  // The list can re-render the message under the pulse; follow the quote into the new nodes.
  function repair() {
    frame = 0;
    if (stopped || !range) return;
    const repaired = resolve();
    if (!repaired) {
      finish();
      return;
    }
    range.setStart(repaired.startContainer, repaired.startOffset);
    range.setEnd(repaired.endContainer, repaired.endOffset);
  }
  const observer = new MutationObserver(() => {
    if (!range) return;
    const detached =
      range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected;
    if (!detached) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(repair);
  });

  current = dispose;
  frame = requestAnimationFrame(locate);
  return dispose;
}
