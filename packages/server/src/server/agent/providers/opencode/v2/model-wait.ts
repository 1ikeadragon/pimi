import type { OpenCodeEvent } from "@opencode/client";

/**
 * Tracks the span where OpenCode has a model request out and no output has come back, so a stalled
 * gateway (a slow LiteLLM, a provider that holds the request) reads as waiting rather than working.
 *
 * Event-driven, with no timer or threshold. A wait closes on the first event that proves output
 * began. `session.step.started` is not an opening event: upstream publishes it lazily, on the first
 * provider event (packages/core/src/session/runner/publish-llm-event.ts `startAssistant`, v2.0.10
 * and v2.4.1), so it only appears once the model has already answered. The opening events are the
 * ones OpenCode emits before the request: the execution starting, a step that ended in tool calls
 * (the next request follows), and a scheduled retry.
 */

// Mirrors upstream `beginsOutput` (publish-llm-event.ts): text, reasoning, tool input, tool call.
const OUTPUT_EVENTS: ReadonlySet<string> = new Set([
  "session.text.started",
  "session.reasoning.started",
  "session.tool.input.started",
  "session.tool.called",
  // Published on the first provider event, so the response has begun even if it carries no output yet.
  "session.step.started",
  "session.step.failed",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

export class ModelWait {
  private since: number | null = null;

  constructor(
    private readonly publish: (since: string | null) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Feed an event that belongs to this session. */
  observe(event: OpenCodeEvent): void {
    if (event.type === "session.execution.started") {
      // A new execution never inherits a wait from one whose terminal event was missed.
      this.since = null;
      this.open();
    } else if (event.type === "session.retry.scheduled") {
      // Upstream publishes `session.step.started` just before scheduling a retry (step.ts,
      // `Outcome.Retry`), which closed the wait above. The retried request is a new wait.
      this.open();
    } else if (event.type === "session.step.ended") {
      // Only a step that ended in tool calls is followed by another request.
      if (event.data.finish === "tool-calls") this.open();
      else this.end();
    } else if (OUTPUT_EVENTS.has(event.type)) {
      this.end();
    }
  }

  /** Close the wait because output can no longer be attributed, e.g. after an event-stream gap. */
  end(): void {
    if (this.since === null) return;
    this.since = null;
    this.publish(null);
  }

  private open(): void {
    // A request already waiting keeps its original start; a retry does not restart the clock.
    if (this.since !== null) return;
    this.since = this.now();
    this.publish(new Date(this.since).toISOString());
  }
}
