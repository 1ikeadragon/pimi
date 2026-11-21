import { setTimeout as delay } from "node:timers/promises";
import type { V2Api } from "./api.js";
import type { ToolCallOutputStream } from "../../../tool-call-output-stream.js";

// OpenCode reports a running shell tool only by its shell id (`session.tool.progress`); the
// output reaches the tool call once the command exits. Reading the shell while it runs feeds the
// shared live output stream.
const POLL_INTERVAL_MS = 500;
const PAGE_LIMIT = 64 * 1024;

interface ShellOutputTailOptions {
  client: () => V2Api;
  cwd: string;
  signal: AbortSignal;
  output: ToolCallOutputStream;
  reportError: (error: unknown) => void;
}

/** Reads the shells behind running shell tool calls, one loop per call. */
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

  /** The call finished. */
  finished(callId: string) {
    this.running.get(callId)?.abort();
    this.running.delete(callId);
    this.options.output.stop(callId);
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
    while (!signal.aborted) {
      for (;;) {
        const page = await this.options
          .client()
          .shell.output({ id: input.shellId, location, cursor, limit: PAGE_LIMIT }, { signal });
        if (!signal.aborted) this.options.output.append(input.callId, page.data.output);
        if (page.data.cursor <= cursor || page.data.cursor >= page.data.size) {
          cursor = Math.max(cursor, page.data.cursor);
          break;
        }
        cursor = page.data.cursor;
      }
      const shell = await this.options
        .client()
        .shell.get({ id: input.shellId, location }, { signal });
      if (shell.data.status !== "running") return;
      await delay(POLL_INTERVAL_MS, undefined, { signal });
    }
  }
}
