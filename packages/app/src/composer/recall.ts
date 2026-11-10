import type { ComposerInputSnapshot, ComposerKeyPressEvent } from "@/composer/input/input";
import type { SentMessage } from "@/stores/session-store";

const PAGE_SIZE = 30;
/** Fetch the next page once the walk is this close to the oldest known message. */
const PREFETCH_MARGIN = 5;
/** Older messages kept per composer; the walk ends there rather than growing without bound. */
const MAX_OLDER_MESSAGES = 510;

export interface SentMessagePageRequest {
  /** Null asks for the newest page. */
  beforeSeq: number | null;
  limit: number;
}

interface PagedSentMessage {
  seq: number;
  text: string;
}

export interface SentMessagePage {
  epoch: string;
  /** Newest first. */
  messages: PagedSentMessage[];
  hasOlder: boolean;
}

export type FetchSentMessagePage = (request: SentMessagePageRequest) => Promise<SentMessagePage>;

/**
 * Every message sent to one agent, newest first. The loaded timeline window
 * supplies what is on screen and whatever was sent since; the daemon supplies
 * the rest in pages that never enter the visible timeline.
 */
export class SentMessageHistory {
  private older: SentMessagePage | null = null;
  private isLoading = false;
  private hasFailed = false;
  private onSettled: (() => void) | null = null;

  /** `fetchPage` is null when the daemon cannot page sent messages; history is then the loaded window. */
  constructor(private readonly fetchPage: FetchSentMessagePage | null) {}

  /** Listens for each page request finishing, whether or not it added messages. */
  subscribe(onSettled: () => void): () => void {
    this.onSettled = onSettled;
    return () => {
      if (this.onSettled === onSettled) this.onSettled = null;
    };
  }

  get isLoadingOlder(): boolean {
    return this.isLoading;
  }

  messages(loaded: readonly SentMessage[]): string[] {
    const older = this.olderFor(loaded);
    if (!older) return collapseRepeats(loaded.map((message) => message.text));
    const newestOlderSeq = older.messages[0]?.seq ?? -1;
    const texts: string[] = [];
    for (const message of loaded) {
      // Messages the daemon has not positioned yet are the ones just sent.
      if (message.position !== null && message.position.seq <= newestOlderSeq) break;
      texts.push(message.text);
    }
    for (const message of older.messages) texts.push(message.text);
    return collapseRepeats(texts);
  }

  /** A failed page is retried when the next walk starts, not on every key press. */
  retryFailedPage(): void {
    this.hasFailed = false;
  }

  /** Requests the next older page when `index` nears the oldest known message. */
  loadOlderNear(index: number, loaded: readonly SentMessage[]): void {
    const { fetchPage } = this;
    if (!fetchPage || this.isLoading || this.hasFailed) return;
    const older = this.olderFor(loaded);
    if (older && (!older.hasOlder || older.messages.length >= MAX_OLDER_MESSAGES)) return;
    if (index < this.messages(loaded).length - PREFETCH_MARGIN) return;

    this.isLoading = true;
    const beforeSeq = older?.messages.at(-1)?.seq ?? null;
    fetchPage({ beforeSeq, limit: PAGE_SIZE })
      .then((page) => this.append(page, beforeSeq))
      .catch((error: unknown) => {
        console.warn("[Composer] Failed to load older sent messages", error);
        this.hasFailed = true;
      })
      .finally(() => {
        this.isLoading = false;
        this.onSettled?.();
      });
  }

  private append(page: SentMessagePage, beforeSeq: number | null): void {
    if (beforeSeq === null) {
      this.older = page;
      return;
    }
    // The pages this one continues are gone, or the timeline was replaced mid-walk.
    if (this.older === null || this.older.epoch !== page.epoch) {
      this.older = null;
      return;
    }
    this.older = {
      epoch: page.epoch,
      messages: [...this.older.messages, ...page.messages],
      hasOlder: page.hasOlder,
    };
  }

  /** Sequence numbers only compare within an epoch, so a replaced timeline drops the pages. */
  private olderFor(loaded: readonly SentMessage[]): SentMessagePage | null {
    const older = this.older;
    if (!older) return null;
    const isSameTimeline = loaded.every(
      (message) => message.position === null || message.position.epoch === older.epoch,
    );
    if (!isSameTimeline) this.older = null;
    return this.older;
  }
}

function collapseRepeats(texts: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const raw of texts) {
    // A textarea reports `\n` line endings; recall matches on its exact value.
    const text = raw.replace(/\r\n?/g, "\n");
    if (text.trim().length === 0 || collapsed[collapsed.length - 1] === text) continue;
    collapsed.push(text);
  }
  return collapsed;
}

interface RecalledMessage {
  index: number;
  text: string;
  /** The user moved the caret off the end, so the arrows belong to the caret again. */
  hasCaretLeft: boolean;
}

export type RecallKeyResult =
  | { kind: "show"; text: string }
  /** The key is consumed while an older page loads; `resume` shows its message. */
  | { kind: "hold" };

/**
 * Walks the messages sent to an agent from an empty composer, like a shell's
 * Up/Down history. The walk continues while the composer holds the recalled
 * text with the caret where recall left it, at the end; an edit or a caret
 * move hands the arrows back to the caret.
 */
export class ComposerRecall {
  private recalled: RecalledMessage | null = null;
  /** An Up held for a page in flight: the first of a walk, or the next older message. */
  private held: "first" | "older" | null = null;

  constructor(private readonly history: SentMessageHistory) {}

  /** True while the composer shows a recalled message the user has not edited. */
  isShowing(text: string): boolean {
    return this.recalled !== null && this.recalled.text === text;
  }

  /**
   * Returns what the composer should do with this key press, or null to leave
   * the key to the input. `readLoaded` is the loaded window's sent messages,
   * newest first, and is only read for keys recall acts on.
   */
  handleKeyPress(
    event: ComposerKeyPressEvent,
    readLoaded: () => readonly SentMessage[],
  ): RecallKeyResult | null {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
    if (event.hasModifier) return null;
    this.held = null;
    const recalled = this.walking(event.input);
    if (!recalled) {
      const { text } = event.input;
      if (this.isShowing(text) || event.key !== "ArrowUp" || text.length > 0) return null;
      const loaded = readLoaded();
      this.history.retryFailedPage();
      return this.show(loaded, 0) ?? this.hold("first", 0, loaded);
    }

    const loaded = readLoaded();
    const index = this.currentIndex(loaded, recalled);
    if (event.key === "ArrowUp") {
      // At the oldest message the key is still consumed. Left to the input it would move the
      // caret to the start and end the walk, so Down could no longer step back.
      return this.show(loaded, index + 1) ?? this.hold("older", index, loaded) ?? { kind: "hold" };
    }
    if (index === 0) {
      this.recalled = null;
      return { kind: "show", text: "" };
    }
    return this.show(loaded, index - 1);
  }

  /**
   * Call when an older page settles. Returns the message a held Up was waiting
   * for, or null when there is none or the user has since taken over the input.
   */
  resume(input: ComposerInputSnapshot, readLoaded: () => readonly SentMessage[]): string | null {
    const { held } = this;
    this.held = null;
    if (held === null) return null;
    if (held === "first") {
      return input.text.length === 0 ? this.textAt(readLoaded(), 0) : null;
    }
    const recalled = this.walking(input);
    if (!recalled) return null;
    const loaded = readLoaded();
    return this.textAt(loaded, this.currentIndex(loaded, recalled) + 1);
  }

  /** The recalled message, while the composer still holds it with the caret at its end. */
  private walking(input: ComposerInputSnapshot): RecalledMessage | null {
    const { text, selection } = input;
    if (!this.recalled || this.recalled.text !== text) {
      this.recalled = null;
      return null;
    }
    const isCaretAtEnd = selection.start === text.length && selection.end === text.length;
    if (!isCaretAtEnd) this.recalled.hasCaretLeft = true;
    return this.recalled.hasCaretLeft ? null : this.recalled;
  }

  /** A message sent mid-walk shifts every index; the recalled text finds its place again. */
  private currentIndex(loaded: readonly SentMessage[], recalled: RecalledMessage): number {
    const messages = this.history.messages(loaded);
    if (messages[recalled.index] === recalled.text) return recalled.index;
    const moved = messages.indexOf(recalled.text);
    return moved === -1 ? recalled.index : moved;
  }

  private show(loaded: readonly SentMessage[], index: number): RecallKeyResult | null {
    const text = this.textAt(loaded, index);
    return text === null ? null : { kind: "show", text };
  }

  private textAt(loaded: readonly SentMessage[], index: number): string | null {
    const text = this.history.messages(loaded)[index];
    if (text === undefined) return null;
    this.recalled = { index, text, hasCaretLeft: false };
    this.history.loadOlderNear(index, loaded);
    return text;
  }

  /** Past the oldest known message: consume the key only if an older page is on its way. */
  private hold(
    held: "first" | "older",
    index: number,
    loaded: readonly SentMessage[],
  ): RecallKeyResult | null {
    this.history.loadOlderNear(index, loaded);
    if (!this.history.isLoadingOlder) return null;
    this.held = held;
    return { kind: "hold" };
  }
}
