import { isDev, isWeb } from "@/constants/platform";
import { useSessionStore } from "@/stores/session-store";
import { measureResidentTail } from "@/timeline/resident-window";
import type { StreamItem } from "@/types/stream";

/**
 * Development-only memory measurement for long chats. `window.__PIMI_MEMORY__()` returns one
 * sample (per-chat resident rows and bytes, mounted rows, DOM nodes, JS heap) and the same
 * sample is logged every 10 s, so a before/after run reads the same numbers from the console.
 */
interface MountedReport {
  mountedRows: number;
  historyStart: number;
}

const mountedByAgent = new Map<string, MountedReport>();

export function reportMountedRows(agentId: string, report: MountedReport | null): void {
  if (!isDev) return;
  if (report) mountedByAgent.set(agentId, report);
  else mountedByAgent.delete(agentId);
}

interface PerformanceWithMemory {
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
}

/**
 * Ordering and identity checks for the resident window: a trim or forward page that leaves a
 * repeat shows up as a repeated id, and one that reorders rows as a seq that goes backwards.
 */
function checkTailIntegrity(tail: readonly StreamItem[]) {
  const ids = new Set<string>();
  let duplicateIds = 0;
  let outOfOrder = 0;
  let previousSeq = -1;
  for (const item of tail) {
    if (ids.has(item.id)) duplicateIds += 1;
    ids.add(item.id);
    const seq = item.timelineCursor?.seq;
    if (seq === undefined) continue;
    if (seq < previousSeq) outOfOrder += 1;
    previousSeq = seq;
  }
  return { duplicateIds, outOfOrder };
}

export function sampleMemory() {
  const chats: Array<Record<string, unknown>> = [];
  for (const [serverId, session] of Object.entries(useSessionStore.getState().sessions)) {
    for (const [agentId, tail] of session.agentStreamTail) {
      const size = measureResidentTail(tail);
      const range = session.agentTimelineCursor.get(agentId);
      const integrity = checkTailIntegrity(tail);
      chats.push({
        serverId,
        agentId,
        tailItems: size.items,
        tailBytes: size.bytes,
        ...integrity,
        firstSeq: tail.find((item) => item.timelineCursor)?.timelineCursor?.seq ?? null,
        lastSeq: tail.findLast((item) => item.timelineCursor)?.timelineCursor?.seq ?? null,
        headItems: session.agentStreamHead.get(agentId)?.length ?? 0,
        startSeq: range?.startSeq ?? null,
        endSeq: range?.endSeq ?? null,
        hasOlder: session.agentTimelineHasOlder.get(agentId) === true,
        hasNewer: session.agentTimelineHasNewer.get(agentId) === true,
        ...mountedByAgent.get(agentId),
      });
    }
  }
  const memory = (performance as unknown as PerformanceWithMemory).memory;
  return {
    at: new Date().toISOString(),
    domNodes: isWeb ? document.getElementsByTagName("*").length : null,
    jsHeapUsed: memory?.usedJSHeapSize ?? null,
    jsHeapTotal: memory?.totalJSHeapSize ?? null,
    chats,
  };
}

declare global {
  var __PIMI_MEMORY__: (() => ReturnType<typeof sampleMemory>) | undefined;
}

let installed = false;

export function installMemoryProbe(): void {
  if (!isDev || installed) return;
  installed = true;
  globalThis.__PIMI_MEMORY__ = sampleMemory;
  setInterval(() => {
    console.info("[memory-probe]", JSON.stringify(sampleMemory()));
  }, 10_000);
}
