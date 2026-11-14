// Pimi. PolyForm-Noncommercial-1.0.0.
// Stream S4 owns this file: the one read of a change request's overview, checks and review threads
// for the Review screen. The Overview cards, the Changes-tab inspector, the file tree badges and the
// Fix sheet all call it; react-query keys the requests by identity, so every caller shares one fetch.
import { i18n } from "@/i18n/i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchQueryOptions, useFetchQueries, useFetchQuery } from "@/data/query";
import { useCallback, useMemo, useRef } from "react";
import type {
  CheckoutCheckDetails,
  ForgeChangeRequestGetOverviewResponse,
  ForgeChangeRequestGetTimelineResponse,
} from "@pimi/protocol/messages";
import { normalizeForge, type Forge } from "@/git/forge";
import { classifyCheck, type CheckPresentation } from "@/git/check-presentation";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import {
  deriveAvatarColor,
  formatAge,
  type PrPaneActivity,
  type PrPaneCheck,
} from "@/git/pull-request-panel/data";
import { mapCheckStatus } from "@/git/pull-request-panel/check-status";
import type { PrThreadEntry } from "@/git/pull-request-panel/timeline";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ChangeRequestSource, ReviewCountsByPath, ReviewSource } from "./types";

type Overview = NonNullable<ForgeChangeRequestGetOverviewResponse["payload"]["overview"]>;
type TimelineItem = ForgeChangeRequestGetTimelineResponse["payload"]["items"][number];

const STALE_MS = 30_000;
// Several components read one change request; none of them refetches just by mounting.
const SHARED = {
  dataShape: "value",
  staleTimeMs: STALE_MS,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
} as const;
/** Annotation badges fetch details for at most this many failing checks. */
const ANNOTATION_CHECK_CAP = 6;

export interface ReviewCheck {
  /** Stable selection id: the check-run id, else the name. */
  key: string;
  name: string;
  workflow: string | null;
  presentation: CheckPresentation;
  /** What the forge reported for how long it ran ("2m"), when it did. */
  duration: string | null;
  url: string;
  checkRunId: number | null;
  workflowRunId: number | null;
  /** True when `get_check_details` can answer for it (the forge gave a run id). */
  hasDetails: boolean;
  pane: PrPaneCheck;
}

export type ReviewCheckSectionId = "attention" | "running" | "passed" | "skipped";

export interface ReviewCheckGroup {
  /** `${workflow}\0${base}`; stable across refreshes. */
  key: string;
  label: string;
  workflow: string | null;
  checks: ReviewCheck[];
  /** The worst presentation among the members. */
  presentation: CheckPresentation;
}

export interface ReviewCheckSection {
  id: ReviewCheckSectionId;
  count: number;
  /** Shards of one job fold into one group; a lone check is a group of one. */
  groups: ReviewCheckGroup[];
}

export interface ReviewThread {
  /** Selection id; equals the `PrThreadEntry` id the attachment builder uses. */
  id: string;
  path: string | null;
  line: number | null;
  startLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  author: string;
  /** One line of the root comment, markup stripped. */
  summary: string;
  url: string;
  entry: PrThreadEntry;
}

export interface ReviewTimeline {
  /** The change request the data belongs to; null while a checkout's branch PR is unresolved. */
  ref: ChangeRequestSource | null;
  overview: Overview | null;
  forge: Forge;
  checks: ReviewCheck[];
  checkSections: ReviewCheckSection[];
  threads: ReviewThread[];
  unresolvedCount: number;
  /** Per-file unresolved-thread and annotation counts for the file tree and diff gutter. */
  counts: ReviewCountsByPath;
  isLoading: boolean;
  checksLoading: boolean;
  threadsLoading: boolean;
  isRefreshing: boolean;
  /** Overview failure (nothing renders without it). */
  error: Error | null;
  threadsError: Error | null;
  threadsTruncated: boolean;
  /** Why a checkout source has no change request, when it does not. */
  noChangeRequest: boolean;
  refresh: () => void;
}

export interface UseReviewTimelineOptions {
  /** Also read the annotations of failing checks so `counts` carries them. Off by default. */
  annotations?: boolean;
}

export function changeRequestRefKey(ref: ChangeRequestSource): readonly unknown[] {
  return [ref.serverId, ref.forgeHost, ref.owner, ref.name, ref.number];
}

function overviewKey(ref: ChangeRequestSource | null) {
  return ["reviewOverview", ...(ref ? changeRequestRefKey(ref) : [])] as const;
}
function timelineKey(ref: ChangeRequestSource | null) {
  return ["reviewTimeline", ...(ref ? changeRequestRefKey(ref) : [])] as const;
}
export function checkDetailsKey(
  ref: ChangeRequestSource,
  ids: { checkRunId: number | null; workflowRunId: number | null },
) {
  return [
    "reviewCheckDetails",
    ...changeRequestRefKey(ref),
    ids.checkRunId,
    ids.workflowRunId,
  ] as const;
}

function toError(error: { message: string } | null | undefined, fallback: string): Error {
  return new Error(error?.message?.trim() ? error.message : fallback);
}

/** The change request behind a source: itself, or the PR the checked-out branch has. */
function useChangeRequestRef(source: ReviewSource): {
  ref: ChangeRequestSource | null;
  noChangeRequest: boolean;
  resolving: boolean;
} {
  const isCheckout = source.kind === "checkout";
  const pr = useCheckoutPrStatusQuery({
    serverId: source.serverId,
    cwd: source.kind === "checkout" ? source.cwd : "",
    enabled: isCheckout,
  });
  return useMemo(() => {
    if (source.kind === "change_request") {
      return { ref: source, noChangeRequest: false, resolving: false };
    }
    const status = pr.status;
    if (status?.number && status.repoOwner && status.repoName && status.url) {
      try {
        const forgeHost = new URL(status.url).hostname.toLowerCase();
        return {
          ref: {
            kind: "change_request" as const,
            serverId: source.serverId,
            forgeHost,
            owner: status.repoOwner,
            name: status.repoName,
            number: status.number,
          },
          noChangeRequest: false,
          resolving: false,
        };
      } catch {
        // A status URL that does not parse has no identity to read.
      }
    }
    return { ref: null, noChangeRequest: !pr.isLoading, resolving: pr.isLoading };
  }, [pr.isLoading, pr.status, source]);
}

export function useReviewTimeline(
  source: ReviewSource,
  options: UseReviewTimelineOptions = {},
): ReviewTimeline {
  const { ref, noChangeRequest, resolving } = useChangeRequestRef(source);
  const client = useHostRuntimeClient(source.serverId);
  const isConnected = useHostRuntimeIsConnected(source.serverId);
  const enabled = !!client && isConnected && ref !== null;
  // The refresh button asks the daemon to skip its short read cache once.
  const refreshNext = useRef(false);

  const overviewQuery = useFetchQuery({
    ...SHARED,
    queryKey: overviewKey(ref),
    enabled,
    queryFn: async () => {
      if (!client || !ref) throw new Error(i18n.t("reviewScreen.errors.noConnection"));
      const payload = await client.forgeChangeRequestGetOverview(
        refInput(ref, refreshNext.current),
      );
      if (!payload.overview)
        throw toError(payload.error, i18n.t("reviewScreen.errors.loadPullRequest"));
      return payload.overview;
    },
  });
  const timelineQuery = useFetchQuery({
    ...SHARED,
    queryKey: timelineKey(ref),
    enabled,
    queryFn: async () => {
      if (!client || !ref) throw new Error(i18n.t("reviewScreen.errors.noConnection"));
      const payload = await client.forgeChangeRequestGetTimeline(
        refInput(ref, refreshNext.current),
      );
      if (payload.error) throw toError(payload.error, i18n.t("reviewScreen.errors.loadThreads"));
      return { items: payload.items, truncated: payload.truncated };
    },
  });

  const overview = overviewQuery.data ?? null;
  const forge = normalizeForge(overview?.forge);
  const checks = useMemo(() => (overview ? buildChecks(overview, forge) : []), [overview, forge]);
  const checkSections = useMemo(() => buildCheckSections(checks), [checks]);
  const threads = useMemo(
    () => buildThreads(timelineQuery.data?.items ?? [], forge),
    [timelineQuery.data, forge],
  );

  const annotationChecks = useMemo(
    () =>
      options.annotations
        ? checks
            .filter((check) => check.hasDetails && isAttention(check.presentation))
            .slice(0, ANNOTATION_CHECK_CAP)
        : [],
    [checks, options.annotations],
  );
  const annotationQueries = useFetchQueries(
    annotationChecks.map((check) => ({
      dataShape: "value" as const,
      staleTimeMs: STALE_MS,
      refetchOnMount: false as const,
      refetchOnWindowFocus: false as const,
      queryKey: ref ? checkDetailsKey(ref, check) : ["reviewCheckDetails", "none"],
      enabled,
      queryFn: () => fetchCheckDetails(client, ref, check),
    })),
  );
  const annotationPaths = annotationQueries
    .flatMap((query) => query.data?.annotations ?? [])
    .map((annotation) => annotation.path)
    .join("\n");

  const counts = useMemo<ReviewCountsByPath>(() => {
    const map = new Map<string, { unresolved: number; annotations: number }>();
    const bump = (path: string, field: "unresolved" | "annotations") => {
      const current = map.get(path) ?? { unresolved: 0, annotations: 0 };
      current[field] += 1;
      map.set(path, current);
    };
    for (const thread of threads) {
      if (thread.path && !thread.isResolved) bump(thread.path, "unresolved");
    }
    for (const path of annotationPaths.split("\n")) {
      if (path) bump(path, "annotations");
    }
    return map;
  }, [annotationPaths, threads]);

  const queryClient = useQueryClient();
  const refresh = useCallback(() => {
    refreshNext.current = true;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: overviewKey(ref) }),
      queryClient.invalidateQueries({ queryKey: timelineKey(ref) }),
      queryClient.invalidateQueries({ queryKey: ["reviewCheckDetails"] }),
    ]).finally(() => {
      refreshNext.current = false;
    });
  }, [queryClient, ref]);

  return {
    ref,
    overview,
    forge,
    checks,
    checkSections,
    threads,
    unresolvedCount: threads.filter((thread) => !thread.isResolved).length,
    counts,
    isLoading: resolving || (enabled && overviewQuery.isPending),
    checksLoading: resolving || (enabled && overviewQuery.isPending),
    threadsLoading: enabled && timelineQuery.isPending,
    isRefreshing:
      (overviewQuery.isFetching && !overviewQuery.isPending) ||
      (timelineQuery.isFetching && !timelineQuery.isPending),
    error:
      overviewQuery.error ??
      (ref && !isConnected ? new Error(i18n.t("reviewScreen.errors.hostOffline")) : null),
    threadsError: timelineQuery.error,
    threadsTruncated: timelineQuery.data?.truncated ?? false,
    noChangeRequest,
    refresh,
  };
}

function refInput(ref: ChangeRequestSource, refresh: boolean) {
  return {
    forgeHost: ref.forgeHost,
    owner: ref.owner,
    name: ref.name,
    number: ref.number,
    ...(refresh ? { refresh: true } : {}),
  };
}

type DetailsClient = ReturnType<typeof useHostRuntimeClient>;

/** `get_check_details` for one check; throws the daemon's message so callers can show it. */
export async function fetchCheckDetails(
  client: DetailsClient,
  ref: ChangeRequestSource | null,
  check: Pick<ReviewCheck, "checkRunId" | "workflowRunId">,
): Promise<CheckoutCheckDetails | null> {
  if (!client || !ref) throw new Error(i18n.t("reviewScreen.errors.noConnection"));
  const payload = await client.forgeChangeRequestGetCheckDetails({
    ...refInput(ref, false),
    ...(check.checkRunId !== null ? { checkRunId: check.checkRunId } : {}),
    ...(check.workflowRunId !== null ? { workflowRunId: check.workflowRunId } : {}),
  });
  if (payload.error) throw toError(payload.error, i18n.t("reviewScreen.errors.loadCheckDetails"));
  return payload.details;
}

/** Details of one check, read when `enabled` (an expanded failing row, or the Fix sheet). */
export function useReviewCheckDetails(source: ReviewSource, check: ReviewCheck, enabled: boolean) {
  const { ref } = useChangeRequestRef(source);
  const client = useHostRuntimeClient(source.serverId);
  return useFetchQuery({
    ...SHARED,
    queryKey: ref ? checkDetailsKey(ref, check) : ["reviewCheckDetails", "none"],
    enabled: enabled && !!client && ref !== null && check.hasDetails,
    queryFn: () => fetchCheckDetails(client, ref, check),
  });
}

/** Refresh-free read for code that is not a component, e.g. the Fix sheet's confirm handler. */
export function useFetchReviewCheckDetails(source: ReviewSource) {
  const { ref } = useChangeRequestRef(source);
  const client = useHostRuntimeClient(source.serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (check: ReviewCheck) =>
      queryClient.fetchQuery(
        fetchQueryOptions({
          ...SHARED,
          queryKey: ref ? checkDetailsKey(ref, check) : ["reviewCheckDetails", "none"],
          queryFn: () => fetchCheckDetails(client, ref, check),
        }),
      ),
  });
}

// ---- derivation ----

export function isAttention(presentation: CheckPresentation): boolean {
  return (
    presentation === "failure" || presentation === "warning" || presentation === "actionRequired"
  );
}

function buildChecks(overview: Overview, forge: Forge): ReviewCheck[] {
  return overview.checks.map((raw) => {
    const status = mapCheckStatus(raw.status);
    const checkRunId = raw.checkRunId ?? null;
    const workflowRunId = raw.workflowRunId ?? null;
    const pane: PrPaneCheck = {
      provider: forge,
      name: raw.name,
      status,
      ...(raw.traits ? { traits: raw.traits } : {}),
      url: raw.url ?? overview.url,
      ...(raw.workflow ? { workflow: raw.workflow } : {}),
      ...(raw.duration ? { timing: raw.duration } : {}),
      ...(checkRunId !== null || workflowRunId !== null
        ? {
            detailRef: {
              ...(checkRunId !== null ? { checkRunId } : {}),
              ...(workflowRunId !== null ? { workflowRunId } : {}),
            },
          }
        : {}),
    };
    return {
      key: checkRunId !== null ? `run:${checkRunId}` : `name:${raw.workflow ?? ""}:${raw.name}`,
      name: raw.name,
      workflow: raw.workflow ?? null,
      presentation: classifyCheck(pane),
      duration: raw.duration ?? null,
      url: raw.url ?? overview.url,
      checkRunId,
      workflowRunId,
      hasDetails: checkRunId !== null || workflowRunId !== null,
      pane,
    };
  });
}

const SECTION_ORDER: ReviewCheckSectionId[] = ["attention", "running", "passed", "skipped"];

function sectionOf(presentation: CheckPresentation): ReviewCheckSectionId {
  if (isAttention(presentation)) return "attention";
  if (presentation === "pending" || presentation === "manual") return "running";
  if (presentation === "success") return "passed";
  return "skipped";
}

// Worst first, so a group of shards reports the shard that needs attention.
const SEVERITY: CheckPresentation[] = [
  "failure",
  "actionRequired",
  "warning",
  "pending",
  "manual",
  "success",
  "ignored",
];

/**
 * "Test Server 3", "build (ubuntu, 20)" and "shard-2/8" share a base with their siblings. The base
 * is the name without a trailing matrix tuple or shard number; two or more checks of one workflow
 * with the same base fold into one group. A heuristic: a name that only ends in a number by chance
 * (two jobs "Node 18" and "Node 20") also folds, which is why the group row lists every member.
 */
export function checkBaseName(name: string): string {
  const withoutMatrix = name.replace(/\s*\([^)]*\)\s*$/, "");
  const withoutShard = withoutMatrix
    .replace(/[\s_-]*(?:shard\s*)?#?\d+\s*(?:\/\s*\d+)?\s*$/i, "")
    .trim();
  return withoutShard.length > 0 ? withoutShard : name;
}

function buildCheckSections(checks: readonly ReviewCheck[]): ReviewCheckSection[] {
  const bySection = new Map<ReviewCheckSectionId, ReviewCheck[]>();
  for (const check of checks) {
    const id = sectionOf(check.presentation);
    bySection.set(id, [...(bySection.get(id) ?? []), check]);
  }
  const sections: ReviewCheckSection[] = [];
  for (const id of SECTION_ORDER) {
    const members = bySection.get(id);
    if (!members?.length) continue;
    sections.push({ id, count: members.length, groups: groupChecks(members) });
  }
  return sections;
}

function groupChecks(checks: readonly ReviewCheck[]): ReviewCheckGroup[] {
  const byBase = new Map<string, ReviewCheck[]>();
  for (const check of checks) {
    const key = `${check.workflow ?? ""}\0${checkBaseName(check.name)}`;
    byBase.set(key, [...(byBase.get(key) ?? []), check]);
  }
  const groups: ReviewCheckGroup[] = [];
  for (const [key, members] of byBase) {
    if (members.length === 1) {
      const only = members[0]!;
      groups.push({
        key: `${key}\0${only.key}`,
        label: only.name,
        workflow: only.workflow,
        checks: members,
        presentation: only.presentation,
      });
      continue;
    }
    const worst = members.reduce((current, member) =>
      SEVERITY.indexOf(member.presentation) < SEVERITY.indexOf(current.presentation)
        ? member
        : current,
    );
    groups.push({
      key,
      label: checkBaseName(members[0]!.name),
      workflow: members[0]!.workflow,
      checks: members,
      presentation: worst.presentation,
    });
  }
  // Workflow, then name, so the rows of one workflow sit together.
  return groups.sort(
    (a, b) => (a.workflow ?? "").localeCompare(b.workflow ?? "") || a.label.localeCompare(b.label),
  );
}

const TAG = /<[^>]*>/g;
const MARKDOWN_NOISE = /[`*_>#]|!?\[([^\]]*)\]\([^)]*\)/g;

/** First readable line of a comment body: no HTML, links reduced to their text. */
export function summarizeCommentBody(body: string): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(details|summary|script|style)[\s\S]*?<\/\1>/gi, (block) =>
      /^<summary/i.test(block) ? block : " ",
    )
    .replace(TAG, " ")
    .replace(MARKDOWN_NOISE, (_match, label: string | undefined) => label ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function buildThreads(items: readonly TimelineItem[], forge: Forge): ReviewThread[] {
  const now = Date.now();
  const byId = new Map<string, { entry: PrThreadEntry; first: PrPaneActivity }>();
  for (const item of items) {
    if (item.kind !== "comment") continue;
    const threadId = item.threadId ?? item.location?.threadId;
    if (!threadId) continue;
    const activity: PrPaneActivity = {
      id: item.id,
      provider: forge,
      kind: "comment",
      author: item.author,
      authorUrl: item.authorUrl,
      avatarColor: deriveAvatarColor(item.author),
      avatarUrl: item.avatarUrl,
      body: item.body,
      age: formatAge(item.createdAt, now),
      url: item.url,
      reviewId: item.reviewId,
      threadId: item.threadId,
      threadIsResolved: item.threadIsResolved,
      location: item.location,
    };
    const existing = byId.get(threadId);
    if (existing) {
      existing.entry.comments.push(activity);
      continue;
    }
    const resolved = item.location?.isResolved ?? item.threadIsResolved;
    byId.set(threadId, {
      first: activity,
      entry: {
        kind: "thread",
        id: `thread:${threadId}`,
        ...(item.location ? { location: item.location } : {}),
        ...(resolved !== undefined ? { isResolved: resolved } : {}),
        comments: [activity],
      },
    });
  }
  return [...byId.values()].map(({ entry, first }) => ({
    id: entry.id,
    path: entry.location?.path ?? null,
    line: entry.location?.line ?? null,
    startLine: entry.location?.startLine ?? null,
    isResolved: entry.isResolved ?? false,
    isOutdated: entry.location?.isOutdated ?? false,
    author: first.author,
    summary: summarizeCommentBody(first.body),
    url: first.url,
    entry,
  }));
}
