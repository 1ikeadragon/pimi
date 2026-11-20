import { setTimeout as delay } from "node:timers/promises";
import type { V2Api } from "./api.js";
import type { ShellOutputUpdate } from "../../../agent-sdk-types.js";

// OpenCode reports a running shell tool only by its shell id (`session.tool.progress`); the
// output reaches the tool call once the command exits. Reading the shell while it runs lets the
// call's view tail it.
const POLL_INTERVAL_MS = 500;
const PAGE_LIMIT = 64 * 1024;
// A client that starts watching mid-command gets at most the newest this much; the whole output
// arrives with the finished call.
const LIVE_OUTPUT_MAX_CHARS = 64 * 1024;

interface ShellOutputTailOptions {
  client: () => V2Api;
  cwd: string;
  signal: AbortSignal;
  publish: (update: { callId: string } & ShellOutputUpdate) => void;
  reportError: (error: unknown) => void;
}

/** Tails the output of the shells behind running shell tool calls, one loop per call. */
export class ShellOutputTail {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly options: ShellOutputTailOptions) {}

  /** A tool call reported progress; a shell id in it means its output can be read. */
  progress(callId: string, metadata: unknown) {
    const shellId =
      metadata && typeof metadata === "object"
        ? (metadata as { shellID?: unknown }).shellID
        : undefined;
    if (typeof shellId !== "string" || this.running.has(callId)) return;
    const controller = new AbortController();
    this.running.set(callId, controller);
    void this.tail({ callId, shellId, signal: controller.signal })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !this.options.signal.aborted)
          this.options.reportError(error);
      })
      .finally(() => {
        if (this.running.get(callId) === controller) this.running.delete(callId);
      });
  }

  /** The call finished; its result carries the whole output from here on. */
  finished(callId: string) {
    this.running.get(callId)?.abort();
    this.running.delete(callId);
  }

  /** The turn ended; no call of it is still running. */
  stopAll() {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }

  private async tail(input: { callId: string; shellId: string; signal: AbortSignal }) {
    const signal = AbortSignal.any([this.options.signal, input.signal]);
    const location = { directory: this.options.cwd };
    let cursor = 0;
    // Characters read so far, and the newest of them.
    let end = 0;
    let tail = "";
    while (!signal.aborted) {
      const start = end;
      let fresh = "";
      while (!signal.aborted) {
        const page = await this.options
          .client()
          .shell.output({ id: input.shellId, location, cursor, limit: PAGE_LIMIT }, { signal });
        if (page.data.output.length > 0) {
          // Only the newest part of a burst can be shown, so the rest is not kept.
          fresh = (fresh + page.data.output).slice(-LIVE_OUTPUT_MAX_CHARS);
          end += page.data.output.length;
        }
        if (page.data.cursor <= cursor || page.data.cursor >= page.data.size) {
          cursor = Math.max(cursor, page.data.cursor);
          break;
        }
        cursor = page.data.cursor;
      }
      if (end > start && !signal.aborted) {
        tail = (tail + fresh).slice(-LIVE_OUTPUT_MAX_CHARS);
        const snapshot = { offset: end - tail.length, output: tail };
        const contiguous = end - fresh.length === start;
        this.options.publish({
          callId: input.callId,
          offset: end - fresh.length,
          output: fresh,
          ...(contiguous ? {} : { reset: true }),
          snapshot,
        });
      }
      const shell = await this.options
        .client()
        .shell.get({ id: input.shellId, location }, { signal });
      if (shell.data.status !== "running") return;
      await delay(POLL_INTERVAL_MS, undefined, { signal });
    }
  }
}
