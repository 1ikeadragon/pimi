import type { Logger } from "pino";
import { OpenCodeHttpError } from "../http-error.js";

/**
 * How long the OpenCode event stream may deliver nothing, not even a heartbeat, before Pimi treats
 * the transport as dead. The server writes an SSE comment every 15 seconds
 * (packages/server/src/handlers/event.ts upstream, v2.0.10 and v2.4.1), so 3 x 15s tolerates two
 * lost heartbeats. It equals `defaultIdleTimeout` in `@opencode/client` (dist/chunks, the
 * `createClientConnection` that OpenCode's own app uses), so Pimi gives up on a stream exactly when
 * OpenCode's clients do. Without it, a half-open connection is only detected by undici's 300s body
 * timeout.
 */
export const EVENT_STREAM_IDLE_TIMEOUT_MS = 45_000;

const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";

export class OpenCodeEventStreamStalledError extends Error {
  constructor(readonly idleMs: number) {
    super(`OpenCode event stream delivered nothing for ${idleMs}ms`);
    this.name = "OpenCodeEventStreamStalledError";
  }
}

/**
 * The `fetch` for one OpenCode connection, `lifetime` aborting every request it makes.
 *
 * The idle watchdog lives here because every session on a connection shares one event stream
 * (`SharedEvents.make` in `@opencode/client`). `onActivity` is per subscriber: aborting one
 * subscriber leaves the stream open while any other subscriber remains, and sessions whose timers
 * fire a few milliseconds apart can keep re-joining a dead stream. Watching the response body
 * guards the transport once, and aborting it errors every subscriber together.
 */
export function createGuardedFetch(lifetime: AbortSignal, logger: Logger): typeof fetch {
  return async (request, init) => {
    const stall = new AbortController();
    const signals = [lifetime, stall.signal];
    if (init?.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    const response = await fetch(request, { ...init, signal });
    const html = response.headers.get("content-type")?.includes("text/html") ?? false;
    if (!response.ok || html) {
      const requestUrl = request instanceof Request ? request.url : String(request);
      throw new OpenCodeHttpError(new URL(requestUrl).pathname, response.status, html);
    }
    if (!response.headers.get("content-type")?.includes(EVENT_STREAM_CONTENT_TYPE)) return response;
    const url = request instanceof Request ? request.url : String(request);
    return watchEventStream(response, { signal, stall, url, logger });
  };
}

interface WatchInput {
  signal: AbortSignal;
  stall: AbortController;
  url: string;
  logger: Logger;
}

function watchEventStream(response: Response, input: WatchInput): Response {
  const { signal, stall, url, logger } = input;
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let lastActivity = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  // One timer, rechecked when it fires, so a stream of deltas costs a timestamp per chunk.
  const arm = (delayMs: number) => {
    timer = setTimeout(() => {
      const idleMs = Date.now() - lastActivity;
      if (idleMs < EVENT_STREAM_IDLE_TIMEOUT_MS) {
        arm(EVENT_STREAM_IDLE_TIMEOUT_MS - idleMs);
        return;
      }
      logger.warn(
        { url, idleMs },
        "OpenCode event stream stalled; closing it so sessions reconnect",
      );
      stall.abort(new OpenCodeEventStreamStalledError(idleMs));
    }, delayMs);
    timer.unref();
  };
  signal.addEventListener("abort", clear, { once: true });
  arm(EVENT_STREAM_IDLE_TIMEOUT_MS);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          clear();
          controller.close();
          return;
        }
        lastActivity = Date.now();
        controller.enqueue(next.value);
      } catch (error) {
        clear();
        controller.error(error);
      }
    },
    async cancel(reason) {
      clear();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
