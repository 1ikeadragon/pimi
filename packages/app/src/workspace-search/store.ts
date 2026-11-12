import { create } from "zustand";
import type {
  WorkspaceSearchFileMatches,
  WorkspaceSearchMatch,
  WorkspaceSearchStats,
} from "@pimi/protocol/workspace-search";
import { INITIAL_SEARCH_FORM, searchKeyOf, type WorkspaceSearchForm } from "./query";

/** Files after this many arrive collapsed, so a broad search opens as a short list. */
const EXPANDED_FILE_LIMIT = 200;

export interface SearchResultFile {
  path: string;
  matches: WorkspaceSearchMatch[];
  /** Occurrences, summed over the lines. */
  occurrences: number;
  collapsed: boolean;
}

export type SearchStatus = "idle" | "searching" | "done" | "error";

export interface ReplaceReport {
  filesChanged: number;
  replacements: number;
  skipped: Array<{ path: string; reason: string }>;
  error: string | null;
}

export interface WorkspaceSearchState {
  form: WorkspaceSearchForm;
  replaceOpen: boolean;
  status: SearchStatus;
  error: string | null;
  /** The run whose results are shown; replies for any other id are stale and dropped. */
  requestId: string | null;
  /** `searchKeyOf` the form the shown results answer, or null before any search. */
  ranKey: string | null;
  files: SearchResultFile[];
  stats: WorkspaceSearchStats | null;
  /** Dismissed result lines, as `path:line`. A dismissed line is kept out of Replace all. */
  dismissed: ReadonlySet<string>;
  replacing: boolean;
  replaceReport: ReplaceReport | null;
  /** Bumped by the keyboard shortcuts; the panel focuses its query field when it changes. */
  focusRequest: number;
}

interface WorkspaceSearchActions {
  setForm(patch: Partial<WorkspaceSearchForm>): void;
  setReplaceOpen(open: boolean): void;
  begin(requestId: string): void;
  reset(): void;
  append(requestId: string, files: WorkspaceSearchFileMatches[]): void;
  finish(
    requestId: string,
    outcome: { error: string | null; stats: WorkspaceSearchStats | null },
  ): void;
  toggleFile(path: string): void;
  dismiss(path: string, line: number | null): void;
  setReplacing(replacing: boolean): void;
  setReplaceReport(report: ReplaceReport | null): void;
  requestFocus(seed?: string): void;
}

export type WorkspaceSearchStore = WorkspaceSearchState & WorkspaceSearchActions;

export function dismissalKey(path: string, line: number): string {
  return `${path}:${line}`;
}

function occurrencesOf(matches: readonly WorkspaceSearchMatch[]): number {
  return matches.reduce((total, match) => total + Math.max(1, match.ranges.length), 0);
}

function createWorkspaceSearchStore() {
  return create<WorkspaceSearchStore>()((set) => ({
    form: INITIAL_SEARCH_FORM,
    replaceOpen: false,
    status: "idle",
    error: null,
    requestId: null,
    ranKey: null,
    files: [],
    stats: null,
    dismissed: new Set(),
    replacing: false,
    replaceReport: null,
    focusRequest: 0,

    setForm: (patch) => set((state) => ({ form: { ...state.form, ...patch } })),
    setReplaceOpen: (replaceOpen) => set({ replaceOpen }),
    begin: (requestId) =>
      set((state) => ({
        requestId,
        ranKey: searchKeyOf(state.form),
        status: "searching",
        error: null,
        files: [],
        stats: null,
        dismissed: new Set(),
        replaceReport: null,
      })),
    reset: () =>
      set((state) => ({
        requestId: null,
        ranKey: searchKeyOf(state.form),
        status: "idle",
        error: null,
        files: [],
        stats: null,
        dismissed: new Set(),
      })),
    append: (requestId, batch) =>
      set((state) => {
        if (state.requestId !== requestId) return state;
        const files = [...state.files];
        const indexByPath = new Map(files.map((file, index) => [file.path, index]));
        for (const incoming of batch) {
          const index = indexByPath.get(incoming.path);
          if (index === undefined) {
            indexByPath.set(incoming.path, files.length);
            files.push({
              path: incoming.path,
              matches: incoming.matches,
              occurrences: occurrencesOf(incoming.matches),
              collapsed: files.length >= EXPANDED_FILE_LIMIT,
            });
          } else {
            const existing = files[index];
            const matches = [...existing.matches, ...incoming.matches];
            files[index] = { ...existing, matches, occurrences: occurrencesOf(matches) };
          }
        }
        return { files };
      }),
    finish: (requestId, outcome) =>
      set((state) =>
        state.requestId !== requestId
          ? state
          : {
              status: outcome.error ? "error" : "done",
              error: outcome.error,
              stats: outcome.stats,
            },
      ),
    toggleFile: (path) =>
      set((state) => ({
        files: state.files.map((file) =>
          file.path === path ? { ...file, collapsed: !file.collapsed } : file,
        ),
      })),
    dismiss: (path, line) =>
      set((state) => {
        const dismissed = new Set(state.dismissed);
        const file = state.files.find((candidate) => candidate.path === path);
        if (!file) return state;
        for (const match of file.matches) {
          if (line === null || match.line === line) dismissed.add(dismissalKey(path, match.line));
        }
        return { dismissed };
      }),
    setReplacing: (replacing) => set({ replacing }),
    setReplaceReport: (replaceReport) => set({ replaceReport }),
    requestFocus: (seed) =>
      set((state) => ({
        focusRequest: state.focusRequest + 1,
        form: seed === undefined ? state.form : { ...state.form, query: seed },
      })),
  }));
}

const storesByWorkspace = new Map<string, ReturnType<typeof createWorkspaceSearchStore>>();

/** One store per workspace, outside React: results survive the panel unmounting and remounting. */
export function getWorkspaceSearchStore(workspaceKey: string) {
  let store = storesByWorkspace.get(workspaceKey);
  if (!store) {
    store = createWorkspaceSearchStore();
    storesByWorkspace.set(workspaceKey, store);
  }
  return store;
}
