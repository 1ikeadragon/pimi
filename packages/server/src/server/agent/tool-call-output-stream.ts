import type { AgentStreamEvent, ShellOutputUpdate } from "./agent-sdk-types.js";

// Live output of running shell tool calls, shared by every provider. A provider adapter only
// feeds the output it learns about; this owns offsets, the size cap and the send rate.

/** A client that starts watching mid-command gets at most the newest this much. */
const LIVE_OUTPUT_MAX_CHARS = 64 * 1024;
/** Chunks arriving within this window go out as one update. */
const FLUSH_INTERVAL_MS = 100;

interface CallOutput {
  /** Characters appended so far. */
  end: number;
  /** Characters already published. */
  sent: number;
  /** Appended but not yet published; trimmed to its newest part when a burst outgrows the cap. */
  pending: string;
  /** The newest published output. */
  tail: string;
}

export type ToolCallOutputUpdate = { callId: string } & ShellOutputUpdate;

export class ToolCallOutputStream {
  private readonly calls = new Map<string, CallOutput>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly publish: (update: ToolCallOutputUpdate) => void) {}

  /** The call wrote `chunk`. */
  append(callId: string, chunk: string) {
    if (chunk.length === 0) return;
    let call = this.calls.get(callId);
    if (!call) {
      call = { end: 0, sent: 0, pending: "", tail: "" };
      this.calls.set(callId, call);
    }
    call.end += chunk.length;
    call.pending += chunk;
    if (call.pending.length > 2 * LIVE_OUTPUT_MAX_CHARS)
      call.pending = call.pending.slice(-LIVE_OUTPUT_MAX_CHARS);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  /** The call finished; its result carries the whole output from here on. */
  stop(callId: string) {
    this.calls.delete(callId);
  }

  /** The turn ended; no call of it is still running. */
  stopAll() {
    this.calls.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Stops every call when `event` ends a turn. */
  observe(event: AgentStreamEvent) {
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    )
      this.stopAll();
  }

  private flush() {
    this.timer = null;
    for (const [callId, call] of this.calls) {
      if (call.pending.length === 0) continue;
      const output = call.pending.slice(-LIVE_OUTPUT_MAX_CHARS);
      call.pending = "";
      const offset = call.end - output.length;
      const contiguous = offset === call.sent;
      call.sent = call.end;
      call.tail = (contiguous ? call.tail + output : output).slice(-LIVE_OUTPUT_MAX_CHARS);
      this.publish({
        callId,
        offset,
        output,
        ...(contiguous ? {} : { reset: true as const }),
        snapshot: { offset: call.end - call.tail.length, output: call.tail },
      });
    }
  }
}
