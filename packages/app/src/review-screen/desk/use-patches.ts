// Pimi. PolyForm-Noncommercial-1.0.0.
// Loads the patches the desk needs and shapes them for `DiffDocument`: every file as a stub that
// fills in as its patch lands (continuous mode), or the active file alone (single-file mode).
import { useCallback, useEffect, useMemo } from "react";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import type { ChangeRequestSource } from "../types";
import {
  fetchPatches,
  forgetPatch,
  patchKey,
  peekPatch,
  touchPatch,
  usePatchCacheVersion,
  type PatchEntry,
} from "./patch-cache";

const PREFETCH_AHEAD = 2;
const NO_FILES: ParsedDiffFile[] = [];

export type DeskMode = "continuous" | "single";

export interface DeskPatches {
  loadedFiles: ReadonlyMap<string, ParsedDiffFile>;
  documentFiles: ParsedDiffFile[];
  activeEntry: PatchEntry | undefined;
  retryActive: () => void;
}

export function useDeskPatches(input: {
  client: Pick<DaemonClient, "forgeChangeRequestGetFileDiffs"> | null;
  source: ChangeRequestSource;
  headSha: string;
  stubs: readonly ParsedDiffFile[];
  mode: DeskMode;
  activePath: string;
}): DeskPatches {
  const { client, source, headSha, stubs, mode, activePath } = input;
  const cacheVersion = usePatchCacheVersion();
  const paths = useMemo(() => stubs.map((file) => file.path), [stubs]);
  const activeIndex = Math.max(0, paths.indexOf(activePath));

  useEffect(() => {
    if (!client) return;
    const window = paths.slice(Math.max(0, activeIndex - 1), activeIndex + 1 + PREFETCH_AHEAD);
    const wanted = mode === "continuous" ? paths : window;
    // The active file goes first so the first diff paints before the rest of the batch queue.
    fetchPatches({
      client,
      source,
      headSha,
      paths: [activePath, ...wanted.filter((path) => path !== activePath)],
      keep: wanted,
    });
  }, [activeIndex, activePath, client, headSha, mode, paths, source]);

  const loadedFiles = useMemo(() => {
    const out = new Map<string, ParsedDiffFile>();
    for (const stub of stubs) {
      const entry = peekPatch(patchKey(source, headSha, stub.path));
      if (entry?.state !== "ready") continue;
      const { file, unavailable } = entry.diff;
      out.set(
        stub.path,
        file ?? { ...stub, status: unavailable === "binary" ? "binary" : "too_large" },
      );
    }
    return out;
    // `cacheVersion` is the invalidation signal for the module-level cache read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersion, headSha, source, stubs]);

  const activeKey = patchKey(source, headSha, activePath);
  const activeEntry = peekPatch(activeKey);
  useEffect(() => {
    touchPatch(activeKey);
  }, [activeKey, cacheVersion]);
  const retryActive = useCallback(() => forgetPatch(activeKey), [activeKey]);

  const documentFiles = useMemo(() => {
    if (mode === "continuous") return stubs.map((stub) => loadedFiles.get(stub.path) ?? stub);
    const active = loadedFiles.get(activePath);
    return active ? [active] : NO_FILES;
  }, [activePath, loadedFiles, mode, stubs]);

  return { loadedFiles, documentFiles, activeEntry, retryActive };
}
