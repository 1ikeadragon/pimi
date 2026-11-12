import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import { dismissalKey, type ReplaceReport, type WorkspaceSearchStore } from "./store";
import { splitGlobList, occurrenceColumn } from "./query";
import type { StoreApi, UseBoundStore } from "zustand";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { getWorkspacePanelAttributes } from "@/panels/panel-instance-attributes";

type SearchStoreHook = UseBoundStore<StoreApi<WorkspaceSearchStore>>;

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random()}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs the search for the store's current form, replacing any search still in flight. */
export function runWorkspaceSearch(input: {
  store: SearchStoreHook;
  client: DaemonClient;
  workspaceId: string;
}): void {
  const { store, client, workspaceId } = input;
  const state = store.getState();
  const previous = state.requestId;
  const { form } = state;
  if (form.query.length === 0) {
    state.reset();
    if (previous && state.status === "searching")
      void client.cancelWorkspaceSearch(previous).catch(() => {});
    return;
  }
  const requestId = newRequestId();
  state.begin(requestId);
  client
    .searchWorkspace(
      {
        workspaceId,
        query: form.query,
        isRegex: form.isRegex,
        matchCase: form.matchCase,
        wholeWord: form.wholeWord,
        include: splitGlobList(form.include),
        exclude: splitGlobList(form.exclude),
        useIgnoreFiles: form.useIgnoreFiles,
      },
      (files) => store.getState().append(requestId, files),
      requestId,
    )
    .then((response) => store.getState().finish(requestId, response))
    .catch((error) => store.getState().finish(requestId, { error: describe(error), stats: null }));
}

/** Stops the search in flight. The results that arrived stay on screen. */
export function cancelWorkspaceSearch(input: {
  store: SearchStoreHook;
  client: DaemonClient;
}): void {
  const { store, client } = input;
  const { requestId, status, files } = store.getState();
  if (!requestId || status !== "searching") return;
  void client.cancelWorkspaceSearch(requestId).catch(() => {});
  // The daemon's own stats arrive with its reply to the run; the list stops changing now.
  store.getState().finish(requestId, {
    error: null,
    stats: {
      files: files.length,
      matches: files.reduce((total, file) => total + file.occurrences, 0),
      unlocated: 0,
      elapsedMs: 0,
      limitHit: null,
      cancelled: true,
      regexDialect: null,
    },
  });
}

/** Paths of file tabs with unsaved edits, which Replace all must leave alone. */
function unsavedFilePaths(workspaceKey: string): Set<string> {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const paths = new Set<string>();
  if (!layout) return paths;
  for (const tab of collectAllTabs(layout.root)) {
    if (
      tab.target.kind === "file" &&
      getWorkspacePanelAttributes(workspaceKey, tab.tabId).modified
    ) {
      paths.add(tab.target.path);
    }
  }
  return paths;
}

export interface ReplacePlan {
  files: Array<{
    path: string;
    expectedMatches: number;
    skip: Array<{ line: number; column: number }>;
  }>;
  occurrences: number;
  /** Files left out because the editor holds unsaved changes to them. */
  unsaved: string[];
}

/** What Replace all would send: every shown file except dismissed lines and unsaved buffers. */
export function planWorkspaceReplace(store: SearchStoreHook, workspaceKey: string): ReplacePlan {
  const { files, dismissed } = store.getState();
  const unsavedPaths = unsavedFilePaths(workspaceKey);
  const plan: ReplacePlan = { files: [], occurrences: 0, unsaved: [] };
  for (const file of files) {
    const skip: ReplacePlan["files"][number]["skip"] = [];
    let expectedMatches = 0;
    let replaced = 0;
    for (const match of file.matches) {
      const isDismissed = dismissed.has(dismissalKey(file.path, match.line));
      match.ranges.forEach((_, index) => {
        expectedMatches += 1;
        if (isDismissed) skip.push({ line: match.line, column: occurrenceColumn(match, index) });
        else replaced += 1;
      });
    }
    if (replaced === 0) continue;
    if (unsavedPaths.has(file.path)) {
      plan.unsaved.push(file.path);
      continue;
    }
    plan.files.push({ path: file.path, expectedMatches, skip });
    plan.occurrences += replaced;
  }
  return plan;
}

/** Sends the plan to the daemon, then searches again so the list shows what is left. */
export async function runWorkspaceReplace(input: {
  store: SearchStoreHook;
  client: DaemonClient;
  workspaceId: string;
  plan: ReplacePlan;
}): Promise<void> {
  const { store, client, workspaceId, plan } = input;
  const { form } = store.getState();
  const skipped: ReplaceReport["skipped"] = plan.unsaved.map((path) => ({
    path,
    reason: "Unsaved changes in the editor.",
  }));
  store.getState().setReplacing(true);
  store.getState().setReplaceReport(null);
  let report: ReplaceReport;
  try {
    const response = await client.replaceInWorkspace(
      {
        workspaceId,
        query: form.query,
        isRegex: form.isRegex,
        matchCase: form.matchCase,
        wholeWord: form.wholeWord,
        replacement: form.replacement,
        files: plan.files,
      },
      (result) => {
        if (result.skippedReason) skipped.push({ path: result.path, reason: result.skippedReason });
      },
    );
    report = {
      filesChanged: response.filesChanged,
      replacements: response.replacements,
      skipped,
      error: response.error,
    };
  } catch (error) {
    report = { filesChanged: 0, replacements: 0, skipped, error: describe(error) };
  }
  store.getState().setReplacing(false);
  runWorkspaceSearch({ store, client, workspaceId });
  // The new search clears the report, so it is set once that search has begun.
  store.getState().setReplaceReport(report);
}
