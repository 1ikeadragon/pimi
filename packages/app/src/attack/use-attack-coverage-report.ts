import { useEffect } from "react";
import { useBrowserStore } from "@/desktop/browser/store";
import { useSessionStore } from "@/stores/session-store";
import { useAttackStore } from "./attack-store";
import { normalizeRoute } from "./attack-graph-model";

// A page that rewrites its URL in a loop must not become a request loop: the newest route per
// tab goes out once this quiet period passes.
const REPORT_DEBOUNCE_MS = 400;

function routeOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return normalizeRoute(parsed.pathname);
  } catch {
    return null;
  }
}

/**
 * Coverage comes from the app, not from the agents: when the URL of a tab an Attack agent owns
 * changes (a tool navigation or a link click inside the page, both reach the browser store), the
 * path is reported to the daemon, which files it under that agent. Mounted once at the root so it
 * runs whichever subview is on screen. Browser tabs only: shell commands and file reads are not
 * seen here.
 */
export function useAttackCoverageReport(): void {
  useEffect(() => {
    // The route each tab was last reported at. Tabs that already exist when this mounts are
    // seeded, so reloading the window does not count their pages again.
    const reported = new Map<string, string>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const seed = useBrowserStore.getState().browsersById;
    for (const record of Object.values(seed)) {
      const route = record.owner ? routeOf(record.url) : null;
      if (route) reported.set(record.browserId, route);
    }

    const send = (browserId: string, runId: string, agentId: string, route: string) => {
      const sessions = useSessionStore.getState().sessions;
      const serverId = Object.entries(useAttackStore.getState().byServer).find(
        ([, host]) => runId in host.runs,
      )?.[0];
      const client = serverId ? sessions[serverId]?.client : null;
      if (!client) {
        // The run is not known yet (or the host is away): try again on the next change.
        reported.delete(browserId);
        return;
      }
      client.attackCoverageRecord({ runId, agentId, route }).catch(() => {
        reported.delete(browserId);
      });
    };

    const check = (browsersById: ReturnType<typeof useBrowserStore.getState>["browsersById"]) => {
      for (const record of Object.values(browsersById)) {
        const owner = record.owner;
        if (!owner) continue;
        const route = routeOf(record.url);
        if (!route || reported.get(record.browserId) === route) continue;
        reported.set(record.browserId, route);
        const pending = timers.get(record.browserId);
        if (pending) clearTimeout(pending);
        timers.set(
          record.browserId,
          setTimeout(() => {
            timers.delete(record.browserId);
            const latest = useBrowserStore.getState().browsersById[record.browserId];
            const latestRoute = latest ? routeOf(latest.url) : null;
            const run = Object.values(useAttackStore.getState().byServer)
              .map((host) => host.runs[owner.runId])
              .find(Boolean);
            // Only a live run counts visits.
            if (!latestRoute || !run || (run.status !== "running" && run.status !== "paused")) {
              reported.delete(record.browserId);
              return;
            }
            send(record.browserId, owner.runId, owner.agentId, latestRoute);
          }, REPORT_DEBOUNCE_MS),
        );
      }
    };

    check(seed);
    const unsubscribe = useBrowserStore.subscribe((state, previous) => {
      if (state.browsersById !== previous.browsersById) check(state.browsersById);
    });
    return () => {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);
}
