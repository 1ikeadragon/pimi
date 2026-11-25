import type { Logger } from "pino";

/** How often the watchdog expects to run. A late run is a stall of the whole daemon. */
const WATCHDOG_INTERVAL_MS = 500;
/**
 * Lateness that gets logged. Terminal frames, agent streams and the relay keepalive share this
 * one loop, so a stall past a second is visible to users, while the 100-600 ms slices of
 * ordinary history loads stay out of the log. The relay drops a control channel after 30 s of
 * silence, which makes any stall of that order a reconnect.
 */
export const EVENT_LOOP_STALL_WARN_MS = 1000;

/**
 * Logs every time the event loop was blocked for EVENT_LOOP_STALL_WARN_MS or more, with how long.
 * The line appears once the loop is free again, so a stall of minutes shows up as one line at its
 * end; correlate its timestamp minus `stalledMs` with the lines logged just before it.
 */
export function startEventLoopStallWatchdog(logger: Logger): () => void {
  const log = logger.child({ module: "event-loop" });
  let expectedAt = performance.now() + WATCHDOG_INTERVAL_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    const stalledMs = Math.round(now - expectedAt);
    expectedAt = now + WATCHDOG_INTERVAL_MS;
    if (stalledMs >= EVENT_LOOP_STALL_WARN_MS) {
      log.warn(
        { stalledMs, rssMb: Math.round(process.memoryUsage().rss / 1048576) },
        "event_loop_stalled",
      );
    }
  }, WATCHDOG_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
