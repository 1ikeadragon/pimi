// Pimi. PolyForm-Noncommercial-1.0.0.
// What the Files tab reads, whatever the source. A pull request's files come from the forge (a
// file list first, patches on demand); a worktree's come from the daemon's live checkout diff,
// already parsed. Each adapter fills one `FilesModel`; the view above it never asks which.
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ChangeRequestFile, ParsedDiffFile } from "@pimi/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useIsCompactFormFactor } from "@/constants/layout";
import { orderCheckoutDiffFiles } from "@/git/diff-order";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { buildReviewDraftKey } from "@/review";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { filesQuery, overviewQuery, type DeskFileList } from "../queries";
import type { ChangeRequestSource, CheckoutSource } from "../types";
import { useDeskCopy } from "./copy";
import type { PatchEntry } from "./patch-cache";
import { chooseDiffMode, stubFile, useDeskThreads, type DeskThreads } from "./use-desk-data";
import { reviewDraftKeyFor } from "./use-review-markers";
import { isReviewTimingEnabled, markReview } from "../timing";
import { REVIEW_DIFF_SCOPE } from "../warm";
import { useDeskPatches, type DeskMode } from "./use-patches";

/** What the view has decided: which file is active and whether the user chose one file at a time. */
export interface FilesView {
  activePath: string;
  singleOverride: boolean;
}

export type FilesStatus =
  | { state: "loading" }
  | { state: "error"; message: string; retry?: () => void }
  | { state: "empty" }
  | { state: "ready" };

export interface FilesModel {
  kind: "change_request" | "checkout";
  status: FilesStatus;
  /** Every changed file without hunks, in tree order: tree rows, counts, document headers. */
  stubs: ParsedDiffFile[];
  totalFiles: number;
  /** What the size of the change allows; `mode` also reflects the user's choice. */
  eligibleMode: DeskMode;
  mode: DeskMode;
  /** Files whose hunks are in hand. */
  loadedFiles: ReadonlyMap<string, ParsedDiffFile>;
  /** What the diff document draws for `mode` (continuous: every file, stubs until patches land). */
  documentFiles: ParsedDiffFile[];
  /** Single-file mode: the active file's patch state, so a failure can say why and retry. */
  activeEntry: PatchEntry | undefined;
  retryActive: () => void;
  /** The viewed-store key of this review. */
  reviewKey: string;
  /** What a viewed mark of `path` is compared with; null when the file is unknown. */
  viewedKeyFor: (path: string) => string | null;
  /** Local line notes live under this key (the chat Changes pane builds the same one). */
  draftKey: string;
  /** The commit the diff is of (pull requests); null for a live worktree. */
  headSha: string | null;
  /** The forge accepts a line comment here: pull requests only. */
  canForgeComment: boolean;
  /** The diff was cut for size; some files are not shown. */
  diffTooLarge: boolean;
  threads: DeskThreads;
  /** The base ref notes are attached against (worktrees). */
  baseRef: string | null;
}

/** The tab is on `view.activePath` when the file exists, else on the first file. */
export function resolveActivePath(paths: readonly string[], activePath: string): string {
  return paths.includes(activePath) ? activePath : (paths[0] ?? "");
}

const NO_THREADS: DeskThreads = { threads: [], counts: new Map(), error: null };
const NO_STUBS: ParsedDiffFile[] = [];
const NO_DOCUMENT: ParsedDiffFile[] = [];
const NO_LOADED: ReadonlyMap<string, ParsedDiffFile> = new Map();

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

// ---- pull request ----

export function useChangeRequestFilesModel(
  source: ChangeRequestSource,
  view: FilesView,
): FilesModel {
  const client = useHostRuntimeClient(source.serverId);
  const connected = useHostRuntimeIsConnected(source.serverId);
  const isCompact = useIsCompactFormFactor();
  const query = useFetchQuery({
    ...filesQuery(source, client),
    enabled: Boolean(client) && connected,
  });
  const overview = useFetchQuery({
    ...overviewQuery(source, client),
    enabled: Boolean(client) && connected,
  });
  const { refetch } = query;
  const list: DeskFileList | undefined = query.data;

  const stubs = useMemo(
    () => (list ? orderCheckoutDiffFiles(list.files.map(stubFile)) : NO_STUBS),
    [list],
  );
  const paths = useMemo(() => stubs.map((file) => file.path), [stubs]);
  const blobByPath = useMemo(
    () => new Map((list?.files ?? []).map((file: ChangeRequestFile) => [file.path, file.blobSha])),
    [list],
  );
  const eligibleMode = list ? chooseDiffMode(list, isCompact) : "continuous";
  const mode: DeskMode = eligibleMode === "single" || view.singleOverride ? "single" : "continuous";
  const activePath = resolveActivePath(paths, view.activePath);
  const patches = useDeskPatches({
    client,
    source,
    headSha: list?.headSha ?? "",
    stubs,
    mode,
    activePath,
  });
  const threads = useDeskThreads(source);
  const draftKey = useMemo(() => reviewDraftKeyFor(source), [source]);
  const reviewKey = `${source.serverId}|${source.forgeHost}/${source.owner}/${source.name}#${source.number}`;
  const viewedKeyFor = useCallback((path: string) => blobByPath.get(path) ?? null, [blobByPath]);

  let status: FilesStatus = { state: "loading" };
  if (list) status = list.files.length === 0 ? { state: "empty" } : { state: "ready" };
  else if (query.error) {
    status = {
      state: "error",
      message: describeError(query.error),
      retry: () => void refetch(),
    };
  }

  return {
    kind: "change_request",
    status,
    stubs,
    totalFiles: list?.totalFiles ?? 0,
    eligibleMode,
    mode,
    loadedFiles: patches.loadedFiles,
    documentFiles: patches.documentFiles,
    activeEntry: patches.activeEntry,
    retryActive: patches.retryActive,
    reviewKey,
    viewedKeyFor,
    draftKey,
    headSha: list?.headSha ?? null,
    canForgeComment: overview.data?.actions.lineComment === true,
    diffTooLarge: false,
    threads,
    baseRef: null,
  };
}

// ---- worktree ----

/** The workspace record of a worktree directory: its id keys local notes, its name titles the page. */
export function useWorkspaceForCwd(serverId: string, cwd: string): WorkspaceDescriptor | null {
  return useSessionStore((state) => {
    const workspaces = state.sessions[serverId]?.workspaces;
    if (!workspaces) return null;
    for (const workspace of workspaces.values()) {
      if (workspace.workspaceDirectory === cwd) return workspace;
    }
    return null;
  });
}

/**
 * A 32-bit FNV-1a hash of a file's hunk text. A worktree has no blob SHA to key a viewed mark on,
 * so the mark stores this instead: the file changing clears its mark, every other file keeps its.
 * Collisions are possible (1 in 2^32 per change) and would leave a changed file marked viewed;
 * acceptable for a convenience mark.
 */
export function hashFileHunks(file: ParsedDiffFile): string {
  let hash = 0x811c9dc5;
  const feed = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  feed(file.path);
  for (const hunk of file.hunks) {
    feed(`@${hunk.oldStart},${hunk.newStart}`);
    for (const line of hunk.lines) {
      feed(line.type);
      feed(line.content);
    }
  }
  return (hash >>> 0).toString(16);
}

function withoutHunks(file: ParsedDiffFile): ParsedDiffFile {
  return { ...file, hunks: [] };
}

/**
 * The previous stubs where nothing a stub carries changed. A stub has no hunks, so a diff that
 * only gains syntax colours leaves every stub as it was and the file tree and header need not
 * render again.
 */
function retainStubs(previous: ParsedDiffFile[], next: ParsedDiffFile[]): ParsedDiffFile[] {
  const byPath = new Map(previous.map((stub) => [stub.path, stub]));
  let unchanged = previous.length === next.length;
  const stubs = next.map((stub, index) => {
    const old = byPath.get(stub.path);
    const retained =
      old &&
      old.oldPath === stub.oldPath &&
      old.status === stub.status &&
      old.isNew === stub.isNew &&
      old.isDeleted === stub.isDeleted &&
      old.additions === stub.additions &&
      old.deletions === stub.deletions
        ? old
        : stub;
    unchanged &&= retained === previous[index];
    return retained;
  });
  return unchanged ? previous : stubs;
}

/** The live diff of a worktree under the compare the source names, with what it is read through. */
export function useCheckoutDiff(source: CheckoutSource | null) {
  const serverId = source?.serverId ?? "";
  const cwd = source?.cwd ?? "";
  const { preferences } = useChangesPreferences();
  const { status: gitStatusPayload } = useCheckoutStatusQuery({ serverId, cwd });
  const gitStatus = gitStatusPayload && gitStatusPayload.isGit ? gitStatusPayload : null;
  const baseRef = gitStatus?.baseRef ?? source?.compare.baseRef ?? undefined;
  const workspace = useWorkspaceForCwd(serverId, cwd);
  const diff = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: source?.compare.mode ?? "uncommitted",
    baseRef,
    ignoreWhitespace: preferences.hideWhitespace,
    // A route that names its base ref (a chat's review offer) subscribes at once; the status
    // still decides the ref when it arrives, and a different one resubscribes.
    enabled: source !== null && (gitStatus !== null || Boolean(source.compare.baseRef)),
    // The chat Changes pane subscribes the same diff; a scope keeps the two subscriptions apart.
    queryScope: REVIEW_DIFF_SCOPE,
  });
  return {
    gitStatusPayload,
    gitStatus,
    baseRef,
    workspace,
    diff,
    ignoreWhitespace: preferences.hideWhitespace,
  };
}

/** Whether any line of the diff carries syntax colours yet. */
function hasColours(files: readonly ParsedDiffFile[]): boolean {
  return files.some((file) =>
    file.hunks.some((hunk) => hunk.lines.some((line) => line.tokens !== undefined)),
  );
}

/** Marks status, first diff and colours as they arrive; `warm` says the diff was in hand at mount. */
function useCheckoutTimingMarks(input: {
  hasStatus: boolean;
  diffLoading: boolean;
  files: readonly ParsedDiffFile[];
}) {
  const { hasStatus, diffLoading, files } = input;
  const warm = useRef(!diffLoading);
  useEffect(() => {
    if (hasStatus) markReview("review:status");
  }, [hasStatus]);
  useEffect(() => {
    if (!diffLoading) markReview("review:diff-first", { warm: warm.current });
  }, [diffLoading]);
  useEffect(() => {
    if (isReviewTimingEnabled() && !diffLoading && hasColours(files))
      markReview("review:diff-colours");
  }, [diffLoading, files]);
}

export function useCheckoutFilesModel(source: CheckoutSource, view: FilesView): FilesModel {
  const { serverId, cwd } = source;
  const isCompact = useIsCompactFormFactor();
  const copy = useDeskCopy();
  const { gitStatusPayload, gitStatus, baseRef, workspace, diff, ignoreWhitespace } =
    useCheckoutDiff(source);
  const notGit = gitStatusPayload !== null && !gitStatusPayload.isGit;
  useCheckoutTimingMarks({
    hasStatus: gitStatusPayload !== null,
    diffLoading: diff.isLoading,
    files: diff.files,
  });

  const ordered = useMemo(() => orderCheckoutDiffFiles(diff.files), [diff.files]);
  const previousStubs = useRef(NO_STUBS);
  const stubs = useMemo(() => {
    const next =
      ordered.length === 0
        ? NO_STUBS
        : retainStubs(previousStubs.current, ordered.map(withoutHunks));
    previousStubs.current = next;
    return next;
  }, [ordered]);
  const byPath = useMemo(() => new Map(ordered.map((file) => [file.path, file])), [ordered]);
  const paths = useMemo(() => stubs.map((file) => file.path), [stubs]);
  // The diff is already in memory, so only the file count bounds continuous scroll.
  const eligibleMode = chooseDiffMode(
    { totalFiles: ordered.length, patchBytesTotal: 0 },
    isCompact,
  );
  const mode: DeskMode = eligibleMode === "single" || view.singleOverride ? "single" : "continuous";
  const activePath = resolveActivePath(paths, view.activePath);
  const documentFiles = useMemo(() => {
    if (mode === "continuous") return ordered.length === 0 ? NO_DOCUMENT : ordered;
    const active = byPath.get(activePath);
    return active ? [active] : NO_DOCUMENT;
  }, [activePath, byPath, mode, ordered]);
  const viewedKeyFor = useCallback(
    (path: string) => {
      const file = byPath.get(path);
      return file ? hashFileHunks(file) : null;
    },
    [byPath],
  );
  const draftKey = useMemo(
    () =>
      buildReviewDraftKey({
        serverId,
        workspaceId: workspace?.id,
        cwd,
        mode: source.compare.mode,
        baseRef,
        ignoreWhitespace,
      }),
    [baseRef, cwd, ignoreWhitespace, serverId, source.compare.mode, workspace?.id],
  );

  let status: FilesStatus = { state: "loading" };
  if (notGit) status = { state: "error", message: copy.notGit };
  else if (gitStatusPayload?.error) {
    status = { state: "error", message: gitStatusPayload.error.message };
  } else if (diff.payloadError) status = { state: "error", message: diff.payloadError.message };
  else if ((gitStatus || source.compare.baseRef) && !diff.isLoading) {
    // The diff payload settles the page; status only adds the not-a-checkout and error cases above.
    status = ordered.length === 0 ? { state: "empty" } : { state: "ready" };
  }

  return {
    kind: "checkout",
    status,
    stubs,
    totalFiles: ordered.length,
    eligibleMode,
    mode,
    loadedFiles: ordered.length === 0 ? NO_LOADED : byPath,
    documentFiles,
    activeEntry: undefined,
    retryActive: noop,
    reviewKey: `${serverId}|checkout:${cwd}`,
    viewedKeyFor,
    draftKey,
    headSha: null,
    canForgeComment: false,
    diffTooLarge: diff.diffTooLarge,
    threads: NO_THREADS,
    baseRef: baseRef ?? null,
  };
}

function noop(): void {}
