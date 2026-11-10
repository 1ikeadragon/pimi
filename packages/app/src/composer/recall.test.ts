import { describe, expect, it } from "vitest";
import type { ComposerKeyPressEvent } from "@/composer/input/input";
import {
  ComposerRecall,
  SentMessageHistory,
  type FetchSentMessagePage,
  type SentMessagePageRequest,
} from "@/composer/recall";
import type { SentMessage } from "@/stores/session-store";

const SENT = ["add tests", "fix the auth bug"];

function press(
  key: string,
  text: string,
  options: { caret?: number; selectionEnd?: number; hasModifier?: boolean } = {},
): ComposerKeyPressEvent {
  const caret = options.caret ?? text.length;
  return {
    key,
    hasModifier: options.hasModifier ?? false,
    preventDefault: () => undefined,
    input: { text, selection: { start: caret, end: options.selectionEnd ?? caret } },
  };
}

function loaded(texts: readonly string[], newestSeq = texts.length): SentMessage[] {
  return texts.map((text, index) => ({
    text,
    position: { epoch: "epoch-1", seq: newestSeq - index },
  }));
}

/** The daemon's side of recall: every message sent to the agent, oldest first, served in pages. */
function sentMessageDaemon(texts: readonly string[], epoch = "epoch-1") {
  const requests: SentMessagePageRequest[] = [];
  const fetchPage: FetchSentMessagePage = async (request) => {
    requests.push(request);
    const all = texts.map((text, index) => ({ seq: index + 1, text }));
    const older = all.filter((message) => message.seq < (request.beforeSeq ?? Infinity));
    const page = older.slice(-request.limit);
    return { epoch, messages: page.toReversed(), hasOlder: page.length < older.length };
  };
  return { requests, fetchPage };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Drives recall the way the composer does: each result becomes the composer text, caret at the end. */
function composerWithRecall(
  initial: readonly SentMessage[] = loaded(SENT),
  fetchPage: FetchSentMessagePage | null = null,
) {
  let text = "";
  let window = initial;
  const snapshot = () => ({ text, selection: { start: text.length, end: text.length } });
  const history = new SentMessageHistory(fetchPage);
  const recall = new ComposerRecall(history);
  history.subscribe(() => {
    const resumed = recall.resume(snapshot(), () => window);
    if (resumed !== null) text = resumed;
  });
  return {
    recall,
    get text() {
      return text;
    },
    type(next: string) {
      text = next;
    },
    receive(next: readonly SentMessage[]) {
      window = next;
    },
    /** The text the key press put in the composer, or null when the key was left to the input. */
    press(key: string, options: { caret?: number; hasModifier?: boolean } = {}) {
      const result = recall.handleKeyPress(press(key, text, options), () => window);
      if (result?.kind !== "show") return null;
      text = result.text;
      return text;
    },
  };
}

describe("ComposerRecall", () => {
  it("walks back through sent messages and forward to an empty composer", () => {
    const composer = composerWithRecall();

    expect(composer.press("ArrowUp")).toBe("add tests");
    expect(composer.press("ArrowUp")).toBe("fix the auth bug");
    expect(composer.press("ArrowDown")).toBe("add tests");
    expect(composer.press("ArrowDown")).toBe("");
    expect(composer.recall.isShowing(composer.text)).toBe(false);
  });

  it("leaves the caret to the input past the oldest message", () => {
    const composer = composerWithRecall();
    composer.press("ArrowUp");
    composer.press("ArrowUp");

    expect(composer.press("ArrowUp")).toBeNull();
    expect(composer.text).toBe("fix the auth bug");
  });

  it("only starts from an empty composer", () => {
    const composer = composerWithRecall();
    composer.type("half written");

    expect(composer.press("ArrowUp")).toBeNull();
    expect(composer.press("ArrowDown")).toBeNull();
  });

  it("ignores Down from an empty composer and Up with no history", () => {
    expect(composerWithRecall().press("ArrowDown")).toBeNull();
    expect(composerWithRecall(loaded([])).press("ArrowUp")).toBeNull();
  });

  it("hands the arrows back to the caret once the recalled message is edited", () => {
    const composer = composerWithRecall();
    composer.press("ArrowUp");
    composer.type("add tests for login");

    expect(composer.recall.isShowing(composer.text)).toBe(false);
    expect(composer.press("ArrowUp")).toBeNull();
    expect(composer.press("ArrowDown")).toBeNull();
  });

  it("walks past a multi-line message while the caret is where recall left it", () => {
    const composer = composerWithRecall(loaded(["first line\nsecond line", "older"]));

    expect(composer.press("ArrowUp")).toBe("first line\nsecond line");
    expect(composer.press("ArrowUp")).toBe("older");
    expect(composer.press("ArrowDown")).toBe("first line\nsecond line");
    expect(composer.press("ArrowDown")).toBe("");
  });

  it("hands the arrows back to the caret once it leaves the end of a recalled message", () => {
    const composer = composerWithRecall(loaded(["first line\nsecond line", "older"]));
    composer.press("ArrowUp");

    expect(composer.press("ArrowUp", { caret: "first line\nsec".length })).toBeNull();
    expect(composer.press("ArrowUp", { caret: 3 })).toBeNull();
    expect(composer.press("ArrowDown")).toBeNull();
    expect(composer.recall.isShowing(composer.text)).toBe(true);
  });

  it("matches the composer text for a message sent with CRLF line endings", () => {
    const composer = composerWithRecall(loaded(["one\r\ntwo", "older"]));

    expect(composer.press("ArrowUp")).toBe("one\ntwo");
    expect(composer.recall.isShowing(composer.text)).toBe(true);
    expect(composer.press("ArrowUp")).toBe("older");
  });

  it("ignores modified arrows, other keys, and a selection", () => {
    const composer = composerWithRecall();

    expect(composer.press("ArrowUp", { hasModifier: true })).toBeNull();
    expect(composer.press("Enter")).toBeNull();
    composer.press("ArrowUp");
    const recall = composer.recall;
    expect(
      recall.handleKeyPress(press("ArrowUp", "add tests", { caret: 0, selectionEnd: 3 }), () =>
        loaded(SENT),
      ),
    ).toBeNull();
  });

  it("reaches messages older than the loaded timeline window", async () => {
    const daemon = sentMessageDaemon(["first", "second", "third", "latest"]);
    const composer = composerWithRecall(loaded(["latest"], 4), daemon.fetchPage);

    expect(composer.press("ArrowUp")).toBe("latest");
    await settle();
    expect(composer.press("ArrowUp")).toBe("third");
    expect(composer.press("ArrowUp")).toBe("second");
    expect(composer.press("ArrowUp")).toBe("first");
    expect(composer.press("ArrowUp")).toBeNull();
    expect(composer.press("ArrowDown")).toBe("second");
    expect(daemon.requests).toEqual([{ beforeSeq: null, limit: 30 }]);
  });

  it("holds an Up pressed before the older page arrives, then shows it", async () => {
    const daemon = sentMessageDaemon(["first", "latest"]);
    const composer = composerWithRecall(loaded(["latest"], 2), daemon.fetchPage);

    composer.press("ArrowUp");
    const held = composer.recall.handleKeyPress(press("ArrowUp", composer.text), () =>
      loaded(["latest"], 2),
    );
    expect(held).toEqual({ kind: "hold" });
    expect(composer.text).toBe("latest");

    await settle();
    expect(composer.text).toBe("first");
  });

  it("drops a held Up when the user edits before the older page arrives", async () => {
    const daemon = sentMessageDaemon(["first", "latest"]);
    const composer = composerWithRecall(loaded(["latest"], 2), daemon.fetchPage);

    composer.press("ArrowUp");
    composer.press("ArrowUp");
    composer.type("latest and more");

    await settle();
    expect(composer.text).toBe("latest and more");
  });

  it("pages older history as the walk nears the end of what is known", async () => {
    const texts = Array.from({ length: 70 }, (_, index) => `message ${index + 1}`);
    const daemon = sentMessageDaemon(texts);
    const composer = composerWithRecall(loaded(["message 70"], 70), daemon.fetchPage);

    const walked: (string | null)[] = [];
    for (let presses = 0; presses < 71; presses += 1) {
      walked.push(composer.press("ArrowUp"));
      await settle();
    }

    expect(walked).toEqual([...texts.toReversed(), null]);
    expect(daemon.requests).toEqual([
      { beforeSeq: null, limit: 30 },
      { beforeSeq: 41, limit: 30 },
      { beforeSeq: 11, limit: 30 },
    ]);
  });

  it("puts a message sent during the walk's session at the front without refetching", async () => {
    const daemon = sentMessageDaemon(["first", "latest"]);
    const composer = composerWithRecall(loaded(["latest"], 2), daemon.fetchPage);
    composer.press("ArrowUp");
    await settle();
    composer.press("ArrowDown");

    composer.receive([{ text: "just sent", position: null }, ...loaded(["latest"], 2)]);

    expect(composer.press("ArrowUp")).toBe("just sent");
    expect(composer.press("ArrowUp")).toBe("latest");
    expect(composer.press("ArrowUp")).toBe("first");
    expect(daemon.requests).toHaveLength(1);
  });

  it("collapses back-to-back repeats across the loaded window and older pages", async () => {
    const daemon = sentMessageDaemon(["first", "again", "again", "again"]);
    const composer = composerWithRecall(loaded(["again", "again"], 4), daemon.fetchPage);

    expect(composer.press("ArrowUp")).toBe("again");
    await settle();
    expect(composer.press("ArrowUp")).toBe("first");
  });

  it("keeps the loaded window when the daemon cannot page sent messages", async () => {
    const composer = composerWithRecall(loaded(["latest"], 4), null);

    expect(composer.press("ArrowUp")).toBe("latest");
    await settle();
    expect(composer.press("ArrowUp")).toBeNull();
  });

  it("keeps the loaded window when a page fails, and retries on the next walk", async () => {
    const daemon = sentMessageDaemon(["first", "latest"]);
    let failing = true;
    const composer = composerWithRecall(loaded(["latest"], 2), (request) =>
      failing ? Promise.reject(new Error("timeout")) : daemon.fetchPage(request),
    );

    composer.press("ArrowUp");
    await settle();
    expect(composer.press("ArrowUp")).toBeNull();

    failing = false;
    composer.press("ArrowDown", { caret: composer.text.length });
    composer.type("");
    composer.press("ArrowUp");
    await settle();
    expect(composer.press("ArrowUp")).toBe("first");
  });

  it("forgets older pages when the timeline is replaced", async () => {
    let daemon = sentMessageDaemon(["first", "latest"]);
    const composer = composerWithRecall(loaded(["latest"], 2), (request) =>
      daemon.fetchPage(request),
    );
    composer.press("ArrowUp");
    await settle();

    daemon = sentMessageDaemon(["rewritten", "latest"], "epoch-2");
    composer.receive([{ text: "latest", position: { epoch: "epoch-2", seq: 2 } }]);

    expect(composer.press("ArrowUp")).toBeNull();
    await settle();
    expect(composer.text).toBe("rewritten");
  });

  it("starts from the daemon's history when the loaded window holds no sent message", async () => {
    const daemon = sentMessageDaemon(["first", "latest"]);
    const composer = composerWithRecall(loaded([]), daemon.fetchPage);

    expect(composer.press("ArrowUp")).toBeNull();
    await settle();
    expect(composer.text).toBe("latest");
    expect(composer.press("ArrowUp")).toBe("first");
  });
});
