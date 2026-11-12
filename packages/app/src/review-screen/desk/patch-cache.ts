// Pimi. Apache-2.0.
// Client-side patch cache for the Changes tab: LRU capped at 64 files or 8 MB (whichever first),
// fetched 8 paths per `get_file_diffs` call with at most 2 calls in flight (the daemon bounds `gh`
// itself). Entries are keyed by head SHA, so a push never serves a stale patch.
import { useSyncExternalStore } from "react";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { ChangeRequestFileDiff } from "@pimi/protocol/messages";
import type { ChangeRequestSource } from "../types";

export const PATCH_CACHE_MAX_FILES = 64;
export const PATCH_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const BATCH_SIZE = 8;
const MAX_IN_FLIGHT = 2;

type Client = Pick<DaemonClient, "forgeChangeRequestGetFileDiffs">;

export type PatchEntry =
  | { state: "ready"; diff: ChangeRequestFileDiff }
  | { state: "failed"; message: string };

const entries = new Map<string, PatchEntry & { bytes: number }>();
const inFlight = new Set<string>();
const waiting: Array<() => void> = [];
let running = 0;
let totalBytes = 0;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function patchKey(source: ChangeRequestSource, headSha: string, path: string): string {
  return `${source.serverId}|${source.forgeHost}/${source.owner}/${source.name}#${source.number}|${headSha}|${path}`;
}

function sizeOf(diff: ChangeRequestFileDiff): number {
  // Painted size, not wire size: hunk text dominates and tokens roughly double it.
  let bytes = 256;
  for (const hunk of diff.file?.hunks ?? []) {
    for (const line of hunk.lines) bytes += line.content.length * 2 + 64;
  }
  return bytes;
}

function evict(protectedKeys: ReadonlySet<string>): void {
  // Map iteration order is insertion order; `touch` re-inserts, so the first key is least recent.
  for (const key of entries.keys()) {
    if (entries.size <= PATCH_CACHE_MAX_FILES && totalBytes <= PATCH_CACHE_MAX_BYTES) return;
    if (protectedKeys.has(key)) continue;
    totalBytes -= entries.get(key)?.bytes ?? 0;
    entries.delete(key);
  }
}

export function touchPatch(key: string): PatchEntry | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

export function peekPatch(key: string): PatchEntry | undefined {
  return entries.get(key);
}

export function patchCacheStats(): { files: number; bytes: number; inFlight: number } {
  return { files: entries.size, bytes: totalBytes, inFlight: inFlight.size };
}

export function clearPatchCache(): void {
  entries.clear();
  totalBytes = 0;
  emit();
}

function acquire(): Promise<void> {
  if (running < MAX_IN_FLIGHT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      running += 1;
      resolve();
    });
  });
}

function release(): void {
  running -= 1;
  waiting.shift()?.();
}

function store(key: string, entry: PatchEntry, protectedKeys: ReadonlySet<string>): void {
  const bytes = entry.state === "ready" ? sizeOf(entry.diff) : 0;
  const previous = entries.get(key);
  if (previous) totalBytes -= previous.bytes;
  entries.delete(key);
  entries.set(key, { ...entry, bytes });
  totalBytes += bytes;
  evict(protectedKeys);
}

/**
 * Fetch every path that is neither cached nor in flight. `keep` names the paths the desk still
 * shows; eviction never drops them, so the visible diff cannot lose a file mid-scroll.
 */
export function fetchPatches(input: {
  client: Client;
  source: ChangeRequestSource;
  headSha: string;
  paths: readonly string[];
  keep: readonly string[];
}): void {
  const { client, source, headSha } = input;
  const protectedKeys = new Set(input.keep.map((path) => patchKey(source, headSha, path)));
  const todo = input.paths.filter((path) => {
    const key = patchKey(source, headSha, path);
    return !entries.has(key) && !inFlight.has(key);
  });
  for (let index = 0; index < todo.length; index += BATCH_SIZE) {
    const batch = todo.slice(index, index + BATCH_SIZE);
    for (const path of batch) inFlight.add(patchKey(source, headSha, path));
    void run(client, source, headSha, batch, protectedKeys);
  }
}

async function run(
  client: Client,
  source: ChangeRequestSource,
  headSha: string,
  batch: string[],
  protectedKeys: ReadonlySet<string>,
): Promise<void> {
  await acquire();
  try {
    const payload = await client.forgeChangeRequestGetFileDiffs({
      forgeHost: source.forgeHost,
      owner: source.owner,
      name: source.name,
      number: source.number,
      headSha,
      paths: batch,
    });
    const byPath = new Map(payload.diffs.map((diff) => [diff.path, diff]));
    for (const path of batch) {
      const diff = byPath.get(path);
      const key = patchKey(source, headSha, path);
      if (diff) {
        store(key, { state: "ready", diff }, protectedKeys);
      } else {
        store(
          key,
          { state: "failed", message: payload.error?.message ?? "The daemon returned no diff" },
          protectedKeys,
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const path of batch) {
      store(patchKey(source, headSha, path), { state: "failed", message }, protectedKeys);
    }
  } finally {
    for (const path of batch) inFlight.delete(patchKey(source, headSha, path));
    release();
    emit();
  }
}

/** Drop a failed entry so the next `fetchPatches` retries it. */
export function forgetPatch(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  totalBytes -= entry.bytes;
  entries.delete(key);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders when any patch lands or is evicted; read entries with `peekPatch`. */
export function usePatchCacheVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}
