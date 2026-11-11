import { useCallback, useEffect, useReducer, useState } from "react";
import type { ToolCallDetail } from "@pimi/protocol/agent-types";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

/**
 * History pages carry a preview of long tool-call bodies. A row whose body was cut fetches the full
 * detail from the daemon when the user opens it. Live rows arrive whole and never fetch.
 */
export interface ToolBodySource {
  serverId: string;
  agentId: string;
  callId: string;
  turnId?: string;
}

export type ToolBodyStatus = "ready" | "loading" | "error";

// Bodies are cached for the session and evicted oldest-first past this many bytes of JSON.
// The daemon caps a body at 64 KB, so the cache holds a few hundred of them.
const CACHE_BYTES = 16 * 1024 * 1024;
const PREFETCH_CONCURRENCY = 3;
const cache = new Map<string, { detail: ToolCallDetail; bytes: number }>();
let cacheBytes = 0;
const inFlight = new Map<string, Promise<void>>();
let prefetchActive = 0;
const prefetchQueue: Array<() => void> = [];

// The omitted length changes when a running call settles, so it is part of the key.
function cacheKey(source: ToolBodySource, omitted: number): string {
  return [source.serverId, source.agentId, source.turnId ?? "", source.callId, omitted].join("\0");
}

function load(source: ToolBodySource, key: string): Promise<void> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const client = getHostRuntimeStore().getClient(source.serverId);
  if (!client) return Promise.reject(new Error("Host disconnected"));
  const request = client
    .getAgentToolBody({
      agentId: source.agentId,
      callId: source.callId,
      turnId: source.turnId,
    })
    .then((detail) => {
      const bytes = JSON.stringify(detail).length;
      cache.set(key, { detail, bytes });
      cacheBytes += bytes;
      for (const [oldKey, entry] of cache) {
        if (cacheBytes <= CACHE_BYTES || oldKey === key) break;
        cache.delete(oldKey);
        cacheBytes -= entry.bytes;
      }
      return undefined;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/**
 * Warm the cache for a body the user is likely to open: hover, press-in, a call in the last turn.
 * Failures are dropped; opening the row retries and shows the error.
 */
export function prefetchToolCallBody(source: ToolBodySource, omitted: number): void {
  if (omitted <= 0) return;
  const key = cacheKey(source, omitted);
  if (cache.has(key) || inFlight.has(key)) return;
  const run = () => {
    prefetchActive += 1;
    load(source, key)
      .catch(() => undefined)
      .finally(() => {
        prefetchActive -= 1;
        prefetchQueue.shift()?.();
      });
  };
  if (prefetchActive < PREFETCH_CONCURRENCY) run();
  else prefetchQueue.push(run);
}

/** `source` null means the body is not wanted (collapsed, live, or never cut). */
export function useToolCallBody(
  source: ToolBodySource | null,
  omitted: number,
  preview: ToolCallDetail | undefined,
): { detail: ToolCallDetail | undefined; status: ToolBodyStatus; retry: () => void } {
  const serverId = source?.serverId;
  const agentId = source?.agentId;
  const callId = source?.callId;
  const turnId = source?.turnId;
  const key =
    serverId && agentId && callId && omitted > 0
      ? cacheKey({ serverId, agentId, callId, turnId }, omitted)
      : null;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!serverId || !agentId || !callId || !key || cache.has(key)) return undefined;
    let cancelled = false;
    setFailedKey(null);
    load({ serverId, agentId, callId, turnId }, key).then(
      () => {
        if (!cancelled) rerender();
        return undefined;
      },
      () => {
        if (!cancelled) setFailedKey(key);
        return undefined;
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, serverId, agentId, callId, turnId, attempt]);

  if (!key) return { detail: preview, status: "ready", retry };
  const full = cache.get(key);
  if (full) return { detail: full.detail, status: "ready", retry };
  return { detail: preview, status: failedKey === key ? "error" : "loading", retry };
}
