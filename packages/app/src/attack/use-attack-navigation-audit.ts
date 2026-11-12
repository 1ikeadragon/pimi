import { useEffect } from "react";
import { getDesktopHost } from "@/desktop/host";
import { useSessionStore } from "@/stores/session-store";
import { useAttackStore } from "./attack-store";

interface RefusedEvent {
  runId: string;
  browserId: string;
  host: string;
}

function readEvent(payload: unknown): RefusedEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (
    typeof record.runId !== "string" ||
    typeof record.browserId !== "string" ||
    typeof record.host !== "string"
  ) {
    return null;
  }
  return { runId: record.runId, browserId: record.browserId, host: record.host.slice(0, 253) };
}

/**
 * The desktop webview guard refuses an off-list navigation in an Attack run's tab and tells this
 * window. The daemon owns the audit log, so the window reports the refusal there: host only.
 */
export function useAttackNavigationAudit(): void {
  useEffect(() => {
    const subscription = getDesktopHost()?.events?.on?.("attack-navigation-refused", (payload) => {
      const event = readEvent(payload);
      if (!event) return;
      const sessions = useSessionStore.getState().sessions;
      const known = Object.entries(useAttackStore.getState().byServer).find(
        ([, host]) => event.runId in host.runs,
      )?.[0];
      const serverIds = known ? [known] : Object.keys(sessions);
      for (const serverId of serverIds) {
        const client = sessions[serverId]?.client;
        // A host that does not know the run answers with an error; the owning host records it.
        client?.attackAuditRecord({ runId: event.runId, detail: event.host }).catch(() => {});
      }
    });
    if (typeof subscription === "function") return subscription;
    return () => {
      void subscription?.then((dispose) => dispose());
    };
  }, []);
}
