// Pimi. PolyForm-Noncommercial-1.0.0.
// Every Review read owns one key and one `queryOptions` here, so a pull request is fetched once no
// matter how many components (header, tabs, file tree, fix sheet) read it.
import { i18n } from "@/i18n/i18next";
import type { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type {
  ChangeRequestFile,
  ForgeChangeRequestGetOverviewResponse,
  ForgeChangeRequestGetStatusResponse,
  ForgeChangeRequestListCommitsResponse,
  ForgeChangeRequestListInboxResponse,
} from "@pimi/protocol/messages";
import { fetchQueryOptions } from "@/data/query";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { ChangeRequestSource } from "./types";

export type ChangeRequestInbox = ForgeChangeRequestListInboxResponse["payload"];
export type InboxItem = ChangeRequestInbox["items"][number];
export type ChangeRequestOverview = NonNullable<
  ForgeChangeRequestGetOverviewResponse["payload"]["overview"]
>;
export type ChangeRequestStatus = NonNullable<
  ForgeChangeRequestGetStatusResponse["payload"]["status"]
>;
export type ChangeRequestCommits = Pick<
  ForgeChangeRequestListCommitsResponse["payload"],
  "commits" | "truncated"
>;

/** The inbox reads GitHub through the host's `gh` login; other forges answer "unsupported". */
export const REVIEW_FORGE_HOST = "github.com";
const INBOX_STALE_MS = 30_000;
const INBOX_LIMIT = 50;
const OVERVIEW_STALE_MS = 30_000;
const STATUS_STALE_MS = 30_000;
const TIMELINE_STALE_MS = 30_000;
const COMMITS_STALE_MS = 60_000;
const FILES_STALE_MS = 60_000;

type Kind = "overview" | "status" | "timeline" | "commits" | "inbox";

export function changeRequestRefKey(ref: ChangeRequestSource | null): readonly unknown[] {
  return ref ? [ref.serverId, ref.forgeHost, ref.owner, ref.name, ref.number] : [];
}

export const reviewKeys = {
  inbox: (serverId: string) => ["review-screen", "inbox", serverId, REVIEW_FORGE_HOST] as const,
  overview: (ref: ChangeRequestSource | null) =>
    ["review-screen", "overview", ...changeRequestRefKey(ref)] as const,
  status: (ref: ChangeRequestSource | null) =>
    ["review-screen", "status", ...changeRequestRefKey(ref)] as const,
  timeline: (ref: ChangeRequestSource | null) =>
    ["review-screen", "timeline", ...changeRequestRefKey(ref)] as const,
  commits: (ref: ChangeRequestSource | null) =>
    ["review-screen", "commits", ...changeRequestRefKey(ref)] as const,
  files: (ref: ChangeRequestSource | null) =>
    ["review-desk", "files", ...changeRequestRefKey(ref)] as const,
  checkDetails: (
    ref: ChangeRequestSource | null,
    ids: { checkRunId: number | null; workflowRunId: number | null },
  ) =>
    ["reviewCheckDetails", ...changeRequestRefKey(ref), ids.checkRunId, ids.workflowRunId] as const,
};

// The refresh button asks the daemon to skip its short read cache once, for one read kind of one
// pull request. The next fetch of that key consumes the mark.
const refreshMarks = new Set<string>();

function markKey(kind: Kind, key: readonly unknown[]): string {
  return `${kind}:${JSON.stringify(key)}`;
}

export function markChangeRequestRefresh(ref: ChangeRequestSource): void {
  for (const kind of ["overview", "status", "timeline", "commits"] as const) {
    refreshMarks.add(markKey(kind, changeRequestRefKey(ref)));
  }
}

/** Marks only the named reads of one pull request for a cache-skipping fetch. */
function markRefresh(ref: ChangeRequestSource, kinds: readonly Kind[]): void {
  for (const kind of kinds) refreshMarks.add(markKey(kind, changeRequestRefKey(ref)));
}

/**
 * After a write: the timeline (and with `status`/`overview`, the decision and head) is re-read
 * past the daemon's cache. Resolves when the mounted reads have refetched.
 */
export function refreshAfterWrite(
  queryClient: QueryClient,
  ref: ChangeRequestSource,
  kinds: ReadonlyArray<"timeline" | "status" | "overview">,
): Promise<unknown> {
  markRefresh(ref, kinds);
  return Promise.all(
    kinds.map((kind) => queryClient.invalidateQueries({ queryKey: reviewKeys[kind](ref) })),
  );
}

export function markInboxRefresh(serverId: string): void {
  refreshMarks.add(markKey("inbox", [serverId]));
}

function consumeRefresh(kind: Kind, key: readonly unknown[]): boolean {
  return refreshMarks.delete(markKey(kind, key));
}

export function refInput(ref: ChangeRequestSource, refresh = false) {
  return {
    forgeHost: ref.forgeHost,
    owner: ref.owner,
    name: ref.name,
    number: ref.number,
    ...(refresh ? { refresh: true } : {}),
  };
}

function toError(error: { message: string } | null | undefined, fallback: string): Error {
  return new Error(error?.message?.trim() ? error.message : fallback);
}

/** Identity helper that types a read's input; `useFetchQuery` and `fetchQueryOptions` both take it. */
function fetchInput<T>(input: Parameters<typeof fetchQueryOptions<T>>[0]) {
  return input;
}

function requireClient(client: DaemonClient | null): DaemonClient {
  if (!client) throw new Error(i18n.t("reviewScreen.errors.noConnection"));
  return client;
}

function requireRef(ref: ChangeRequestSource | null): ChangeRequestSource {
  if (!ref) throw new Error(i18n.t("reviewScreen.errors.noConnection"));
  return ref;
}

export function inboxQuery(serverId: string, client: DaemonClient | null) {
  return fetchInput({
    queryKey: reviewKeys.inbox(serverId),
    dataShape: "list",
    staleTimeMs: INBOX_STALE_MS,
    queryFn: async (): Promise<ChangeRequestInbox> =>
      requireClient(client).forgeChangeRequestListInbox({
        forgeHost: REVIEW_FORGE_HOST,
        scopes: ["review_requested", "authored"],
        limit: INBOX_LIMIT,
        ...(consumeRefresh("inbox", [serverId]) ? { refresh: true } : {}),
      }),
  });
}

export function overviewQuery(ref: ChangeRequestSource | null, client: DaemonClient | null) {
  return fetchInput({
    queryKey: reviewKeys.overview(ref),
    dataShape: "value",
    staleTimeMs: OVERVIEW_STALE_MS,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<ChangeRequestOverview> => {
      const payload = await requireClient(client).forgeChangeRequestGetOverview(
        refInput(requireRef(ref), consumeRefresh("overview", changeRequestRefKey(ref))),
      );
      if (!payload.overview) {
        throw toError(payload.error, i18n.t("reviewScreen.errors.loadPullRequest"));
      }
      return payload.overview;
    },
  });
}

export function statusQuery(ref: ChangeRequestSource | null, client: DaemonClient | null) {
  return fetchInput({
    queryKey: reviewKeys.status(ref),
    dataShape: "value",
    staleTimeMs: STATUS_STALE_MS,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<ChangeRequestStatus> => {
      const payload = await requireClient(client).forgeChangeRequestGetStatus(
        refInput(requireRef(ref), consumeRefresh("status", changeRequestRefKey(ref))),
      );
      if (!payload.status) throw toError(payload.error, i18n.t("reviewScreen.errors.loadChecks"));
      return payload.status;
    },
  });
}

export function timelineQuery(ref: ChangeRequestSource | null, client: DaemonClient | null) {
  return fetchInput({
    queryKey: reviewKeys.timeline(ref),
    dataShape: "value",
    staleTimeMs: TIMELINE_STALE_MS,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const payload = await requireClient(client).forgeChangeRequestGetTimeline(
        refInput(requireRef(ref), consumeRefresh("timeline", changeRequestRefKey(ref))),
      );
      if (payload.error) throw toError(payload.error, i18n.t("reviewScreen.errors.loadThreads"));
      return { items: payload.items, truncated: payload.truncated };
    },
  });
}

export function commitsQuery(ref: ChangeRequestSource | null, client: DaemonClient | null) {
  return fetchInput({
    queryKey: reviewKeys.commits(ref),
    dataShape: "value",
    staleTimeMs: COMMITS_STALE_MS,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<ChangeRequestCommits> => {
      const payload = await requireClient(client).forgeChangeRequestListCommits(
        refInput(requireRef(ref), consumeRefresh("commits", changeRequestRefKey(ref))),
      );
      if (payload.error) throw toError(payload.error, i18n.t("reviewScreen.errors.loadCommits"));
      return { commits: payload.commits, truncated: payload.truncated };
    },
  });
}

export interface DeskFileList {
  baseSha: string;
  headSha: string;
  totalFiles: number;
  patchBytesTotal: number;
  files: ChangeRequestFile[];
}

export function filesQuery(ref: ChangeRequestSource | null, client: DaemonClient | null) {
  return fetchInput({
    queryKey: reviewKeys.files(ref),
    dataShape: "value",
    staleTimeMs: FILES_STALE_MS,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<DeskFileList> => {
      const payload = await requireClient(client).forgeChangeRequestListFiles(
        refInput(requireRef(ref)),
      );
      if (payload.error) throw new Error(payload.error.message);
      if (!payload.snapshot) throw new Error(i18n.t("reviewScreen.errors.noFileList"));
      return { ...payload.snapshot, files: payload.files };
    },
  });
}

/** Marks the pull request's reads stale after a write; the mounted ones refetch. */
export function invalidateChangeRequest(queryClient: QueryClient, ref: ChangeRequestSource) {
  markChangeRequestRefresh(ref);
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: reviewKeys.overview(ref) }),
    queryClient.invalidateQueries({ queryKey: reviewKeys.status(ref) }),
    queryClient.invalidateQueries({ queryKey: reviewKeys.timeline(ref) }),
    queryClient.invalidateQueries({ queryKey: reviewKeys.commits(ref) }),
  ]);
}

function prefetchRead<T>(
  queryClient: QueryClient,
  input: Parameters<typeof fetchQueryOptions<T>>[0],
) {
  // prefetchQuery skips a fresh entry and shares a fetch already in flight; a failure is left in
  // the cache for the screen to show, so there is nothing to catch here.
  return queryClient.prefetchQuery(fetchQueryOptions(input));
}

/** Everything the detail page needs, fired together when a row is pressed. */
export function prefetchChangeRequest(
  queryClient: QueryClient,
  client: DaemonClient | null,
  ref: ChangeRequestSource,
): void {
  if (!client) return;
  void prefetchRead(queryClient, overviewQuery(ref, client));
  void prefetchRead(queryClient, statusQuery(ref, client));
  void prefetchRead(queryClient, timelineQuery(ref, client));
  void prefetchRead(queryClient, filesQuery(ref, client));
}

const HOVER_INTENT_MS = 150;
// One hover prefetch at a time: a later hover waits for the earlier one instead of fanning out
// `gh` calls (the daemon runs a handful at once and GitHub's budget is shared).
let hoverQueue: Promise<unknown> = Promise.resolve();

/**
 * REST-only warm-up of a hovered row: overview and file list. Returns the cancel for the hover
 * intent timer; once the timer has fired the prefetch is not cancelled.
 */
export function prefetchOnHover(queryClient: QueryClient, ref: ChangeRequestSource): () => void {
  const timer = setTimeout(() => {
    const client = getHostRuntimeStore().getClient(ref.serverId);
    if (!client) return;
    hoverQueue = hoverQueue.then(() =>
      Promise.all([
        prefetchRead(queryClient, overviewQuery(ref, client)),
        prefetchRead(queryClient, filesQuery(ref, client)),
      ]),
    );
  }, HOVER_INTENT_MS);
  return () => clearTimeout(timer);
}
