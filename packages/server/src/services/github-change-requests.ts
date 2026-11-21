import { LRUCache } from "lru-cache";
import { z } from "zod";
import type {
  ChangeRequestCommit,
  ChangeRequestFile,
  ChangeRequestFileDiff,
  ChangeRequestInboxItem,
  ChangeRequestOverview,
  ChangeRequestStatus,
} from "@pimi/protocol/messages";
import { highlightDiffFromHunks, parseDiff } from "../server/utils/diff-highlighter.js";
import {
  ChangeRequestReadError,
  computeChecksStatus,
  type ChangeRequestCommitList,
  type ChangeRequestFileDiffs,
  type ChangeRequestFileList,
  type ChangeRequestInbox,
  type ChangeRequestInboxSource,
  type ChangeRequestReadOptions,
  type GetChangeRequestFileDiffsOptions,
  type ListChangeRequestInboxOptions,
  type PullRequestCheck,
  type PullRequestReviewDecision,
} from "./forge-service.js";

// Bounds on network and memory work. Reaching one is reported to the client, never silently clipped.
const GH_CONCURRENCY = 6;
const GH_MAX_PENDING = 64;
// GitHub's maximum; a page costs one round trip whatever its size.
const FILES_PAGE_SIZE = 100;
// GitHub's pull request files endpoint stops at 3,000 files.
const GITHUB_FILE_LIMIT = 3000;
const FILE_PATCH_MAX_BYTES = 1024 * 1024;
// Patch text of every retained snapshot, across pull requests.
const SNAPSHOT_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const SNAPSHOT_CACHE_MAX_ENTRIES = 12;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_MAX_PATCH_BYTES = 32 * 1024 * 1024;
const OVERVIEW_TTL_MS = 30_000;
const COMMITS_PAGE_SIZE = 100;
const OVERVIEW_CHECK_CONTEXT_LIMIT = 100;
const INBOX_REPOSITORY_CONCURRENCY = GH_CONCURRENCY;

const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

// REST `pulls/{number}`: one round trip carries the header, the description and the revision pair
// the file snapshot brackets its page reads with.
const PullSchema = z.object({
  html_url: z.string(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  user: z.object({ login: z.string(), html_url: z.string().nullable().optional() }).nullable(),
  head: z.object({ sha: ShaSchema, ref: z.string() }),
  base: z.object({ sha: ShaSchema, ref: z.string() }),
  mergeable: z.boolean().nullable().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changed_files: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative().optional(),
  labels: z.array(z.object({ name: z.string() })).optional(),
});

const FilesPageSchema = z.array(
  z.object({
    filename: z.string().min(1),
    status: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative(),
    sha: z.string(),
    patch: z.string().optional(),
    previous_filename: z.string().optional(),
  }),
);

const CommitsPageSchema = z.array(
  z.object({
    sha: ShaSchema,
    html_url: z.string(),
    commit: z.object({
      message: z.string(),
      author: z
        .object({ name: z.string().optional(), date: z.string().optional() })
        .nullable()
        .optional(),
    }),
    author: z.object({ login: z.string() }).nullable().optional(),
  }),
);

const StatusGraphqlSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              reviewDecision: z.string().nullable().optional(),
              viewerDidAuthor: z.boolean(),
              viewerLatestReview: z.object({ state: z.string() }).nullable().optional(),
              latest: z
                .object({
                  nodes: z.array(
                    z.object({
                      commit: z
                        .object({
                          statusCheckRollup: z
                            .object({
                              contexts: z.object({
                                pageInfo: z.object({ hasNextPage: z.boolean() }),
                                nodes: z.array(z.unknown()),
                              }),
                            })
                            .nullable(),
                        })
                        .nullable(),
                    }),
                  ),
                })
                .optional(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

const SearchIssuesSchema = z.object({
  total_count: z.number().optional(),
  incomplete_results: z.boolean().optional(),
  items: z.array(
    z.object({
      number: z.number().int().positive(),
      title: z.string(),
      state: z.string(),
      draft: z.boolean().optional(),
      html_url: z.string(),
      updated_at: z.string().nullable().optional(),
      repository_url: z.string(),
      user: z.object({ login: z.string() }).nullable().optional(),
      pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
    }),
  ),
});

const PrListSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    url: z.string(),
    title: z.string(),
    state: z.string(),
    isDraft: z.boolean().optional(),
    author: z.object({ login: z.string() }).nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    baseRefName: z.string().nullable().optional(),
    headRefName: z.string().nullable().optional(),
    headRefOid: z.string().nullable().optional(),
    reviewDecision: z.string().nullable().optional(),
    statusCheckRollup: z.unknown().optional(),
  }),
);

const REPOSITORY_FROM_API_URL =
  /\/repos\/([A-Za-z0-9_][A-Za-z0-9._-]*)\/([A-Za-z0-9_][A-Za-z0-9._-]*)$/;

const STATUS_QUERY_HEAD = `
query ChangeRequestStatus($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      viewerDidAuthor
      viewerLatestReview { state }`;

const STATUS_QUERY_CHECKS = `
      latest: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: ${OVERVIEW_CHECK_CONTEXT_LIMIT}) {
                pageInfo {
                  hasNextPage
                }
                nodes {
                  __typename
                  ... on CheckRun {
                    databaseId
                    name
                    status
                    conclusion
                    detailsUrl
                    startedAt
                    completedAt
                    checkSuite {
                      workflowRun {
                        databaseId
                        workflow {
                          name
                        }
                      }
                    }
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                    createdAt
                  }
                }
              }
            }
          }
        }
      }`;

const STATUS_QUERY_TAIL = `
    }
  }
}`;

interface PatchRecord {
  path: string;
  oldPath: string | null;
  status: ChangeRequestFile["status"];
  additions: number;
  deletions: number;
  changes: number;
  blobSha: string;
  patch: string | null;
}

interface Snapshot {
  baseSha: string;
  headSha: string;
  records: PatchRecord[];
  byPath: Map<string, PatchRecord>;
  patchBytes: number;
}

export interface GitHubChangeRequestReaderDeps {
  /** Runs `gh` against `forgeHost` and returns stdout. Throws {@link ChangeRequestReadError}. */
  run: (args: string[], forgeHost: string) => Promise<string>;
  parseChecks: (rollup: unknown) => PullRequestCheck[];
  mapReviewDecision: (value: unknown) => PullRequestReviewDecision;
  /** Converts a GraphQL CheckRun node to the `gh pr view` rollup shape `parseChecks` reads. */
  toRollupNode: (node: unknown) => unknown;
  now: () => number;
}

export interface GitHubChangeRequestReader {
  listChangeRequestInbox(options: ListChangeRequestInboxOptions): Promise<ChangeRequestInbox>;
  getChangeRequestOverview(
    options: ChangeRequestReadOptions,
  ): Promise<Omit<ChangeRequestOverview, "actions">>;
  getChangeRequestStatus(options: ChangeRequestReadOptions): Promise<ChangeRequestStatus>;
  listChangeRequestCommits(options: ChangeRequestReadOptions): Promise<ChangeRequestCommitList>;
  listChangeRequestFiles(options: ChangeRequestReadOptions): Promise<ChangeRequestFileList>;
  getChangeRequestFileDiffs(
    options: GetChangeRequestFileDiffsOptions,
  ): Promise<ChangeRequestFileDiffs>;
}

function refKey(ref: { forgeHost: string; owner: string; name: string; number: number }): string {
  return `${ref.forgeHost}/${ref.owner}/${ref.name}#${ref.number}`.toLowerCase();
}

/** Bounds concurrent `gh` processes and the queue behind them. */
export function createLimiter(concurrency: number, maxPending: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      if (waiting.length >= maxPending) {
        throw new ChangeRequestReadError(
          "unavailable",
          "Too many change request reads are pending. Try again shortly.",
        );
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
}

export function parseJson<T>(stdout: string, schema: z.ZodType<T>, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ChangeRequestReadError("unavailable", `GitHub returned an unreadable ${what}.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ChangeRequestReadError("unavailable", `GitHub returned an unexpected ${what}.`);
  }
  return parsed.data;
}

const FILE_STATUS: Record<string, ChangeRequestFile["status"]> = {
  added: "added",
  removed: "deleted",
  modified: "modified",
  renamed: "renamed",
  copied: "copied",
  changed: "type_changed",
  unchanged: "modified",
};

function toState(state: string, merged: boolean): "open" | "closed" | "merged" {
  if (merged) {
    return "merged";
  }
  return state.toUpperCase() === "OPEN" ? "open" : "closed";
}

function toFileRecord(file: z.infer<typeof FilesPageSchema>[number]): PatchRecord {
  return {
    path: file.filename,
    oldPath: file.previous_filename ?? null,
    status: FILE_STATUS[file.status] ?? "modified",
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blobSha: file.sha,
    patch: typeof file.patch === "string" ? file.patch : null,
  };
}

function toWireFile(record: PatchRecord): ChangeRequestFile {
  return {
    path: record.path,
    oldPath: record.oldPath,
    status: record.status,
    additions: record.additions,
    deletions: record.deletions,
    blobSha: record.blobSha,
    patchBytes: record.patch === null ? null : Buffer.byteLength(record.patch),
  };
}

// A constant header keeps the parser's path logic away from forge-supplied names; the real path and
// rename source come from the file record instead.
const SYNTHETIC_DIFF_HEADER = "diff --git a/f b/f\n--- a/f\n+++ b/f\n";

function toFileDiff(record: PatchRecord): ChangeRequestFileDiff {
  const base = { path: record.path };
  if (record.patch === null) {
    if ((record.status === "renamed" || record.status === "copied") && record.changes === 0) {
      return {
        ...base,
        file: {
          path: record.path,
          ...(record.oldPath ? { oldPath: record.oldPath } : {}),
          isNew: false,
          isDeleted: false,
          additions: 0,
          deletions: 0,
          hunks: [],
          status: "ok",
        },
        unavailable: null,
        message: null,
      };
    }
    if (record.changes > 0) {
      return {
        ...base,
        file: null,
        unavailable: "too_large",
        message: "GitHub did not provide a patch for this file. Open it on the forge.",
      };
    }
    return {
      ...base,
      file: null,
      unavailable: "binary",
      message: "This file has no text patch (binary file or mode-only change).",
    };
  }
  if (Buffer.byteLength(record.patch) > FILE_PATCH_MAX_BYTES) {
    return {
      ...base,
      file: null,
      unavailable: "too_large",
      message: "This patch exceeds the 1 MB display limit. Open it on the forge.",
    };
  }
  // GitHub can truncate a patch; never present a partial one as complete.
  const lines = record.patch.split("\n");
  const additions = lines.filter((line) => line.startsWith("+")).length;
  const deletions = lines.filter((line) => line.startsWith("-")).length;
  if (additions !== record.additions || deletions !== record.deletions) {
    return {
      ...base,
      file: null,
      unavailable: "incomplete",
      message: "GitHub returned an incomplete patch for this file. Open it on the forge.",
    };
  }
  const [parsed] = parseDiff(`${SYNTHETIC_DIFF_HEADER}${record.patch}`);
  if (!parsed) {
    return {
      ...base,
      file: null,
      unavailable: "incomplete",
      message: "This patch could not be parsed.",
    };
  }
  const file = highlightDiffFromHunks({
    ...parsed,
    path: record.path,
    isNew: record.status === "added",
    isDeleted: record.status === "deleted",
    additions: record.additions,
    deletions: record.deletions,
    status: "ok",
  });
  return {
    ...base,
    file: { ...file, ...(record.oldPath ? { oldPath: record.oldPath } : {}) },
    unavailable: null,
    message: null,
  };
}

type Pull = z.infer<typeof PullSchema>;

function toMergeable(value: boolean | null | undefined): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
  if (value === true) {
    return "MERGEABLE";
  }
  return value === false ? "CONFLICTING" : "UNKNOWN";
}

function mapViewerReview(state: string | undefined): ChangeRequestStatus["viewerLatestReview"] {
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes_requested";
  if (state === "COMMENTED") return "commented";
  return null;
}

function buildOverview(
  ref: ChangeRequestReadOptions,
  pull: Pull,
): Omit<ChangeRequestOverview, "actions"> {
  const merged = pull.merged === true;
  return {
    forge: "github",
    forgeHost: ref.forgeHost,
    owner: ref.owner,
    name: ref.name,
    number: ref.number,
    url: pull.html_url,
    title: pull.title,
    body: pull.body ?? "",
    state: toState(pull.state, merged),
    isDraft: pull.draft ?? false,
    isMerged: merged,
    author: pull.user?.login ?? null,
    authorUrl: pull.user?.html_url ?? null,
    createdAt: pull.created_at ?? null,
    updatedAt: pull.updated_at ?? null,
    baseRefName: pull.base.ref,
    headRefName: pull.head.ref,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    mergeable: toMergeable(pull.mergeable),
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    changedFiles: pull.changed_files,
    commitCount: pull.commits ?? 0,
    labels: (pull.labels ?? []).map((label) => label.name),
  };
}

/** A read-through cache with a TTL that also shares the request already in flight. */
function createTimedCache<T>(now: () => number, ttlMs: number) {
  const values = new Map<string, { at: number; value: T }>();
  const inFlight = new Map<string, Promise<T>>();
  return {
    get(key: string, force: boolean | undefined, load: () => Promise<T>): Promise<T> {
      const cachedValue = values.get(key);
      if (!force && cachedValue && now() - cachedValue.at < ttlMs) {
        return Promise.resolve(cachedValue.value);
      }
      const existing = inFlight.get(key);
      if (existing && !force) {
        return existing;
      }
      const pending = load()
        .then((value) => {
          values.set(key, { at: now(), value });
          return value;
        })
        .finally(() => {
          if (inFlight.get(key) === pending) {
            inFlight.delete(key);
          }
        });
      inFlight.set(key, pending);
      return pending;
    },
  };
}

export function createGitHubChangeRequestReader(
  deps: GitHubChangeRequestReaderDeps,
): GitHubChangeRequestReader {
  const limit = createLimiter(GH_CONCURRENCY, GH_MAX_PENDING);
  const gh = (args: string[], forgeHost: string): Promise<string> =>
    limit(() => deps.run(args, forgeHost));

  // Snapshots are keyed by head SHA so a file diff is always answered from the revision the client
  // listed, never from a newer push.
  const snapshots = new LRUCache<string, Snapshot>({
    max: SNAPSHOT_CACHE_MAX_ENTRIES,
    maxSize: SNAPSHOT_CACHE_MAX_BYTES,
    sizeCalculation: (snapshot) => Math.max(1, snapshot.patchBytes),
    ttl: SNAPSHOT_TTL_MS,
  });
  const inFlightSnapshots = new Map<string, Promise<Snapshot>>();
  const pulls = createTimedCache<Pull>(deps.now, OVERVIEW_TTL_MS);
  const statuses = createTimedCache<ChangeRequestStatus>(deps.now, OVERVIEW_TTL_MS);
  const commitLists = createTimedCache<ChangeRequestCommitList>(deps.now, OVERVIEW_TTL_MS);

  function readPull(ref: ChangeRequestReadOptions, force: boolean | undefined): Promise<Pull> {
    return pulls.get(refKey(ref), force, async () =>
      parseJson(
        await gh(
          ["api", "--method", "GET", `repos/${ref.owner}/${ref.name}/pulls/${ref.number}`],
          ref.forgeHost,
        ),
        PullSchema,
        "pull request",
      ),
    );
  }

  async function readFilesPage(ref: ChangeRequestReadOptions, page: number) {
    return parseJson(
      await gh(
        [
          "api",
          "--method",
          "GET",
          `repos/${ref.owner}/${ref.name}/pulls/${ref.number}/files`,
          "-F",
          `per_page=${FILES_PAGE_SIZE}`,
          "-F",
          `page=${page}`,
        ],
        ref.forgeHost,
      ),
      FilesPageSchema,
      "file list",
    );
  }

  function samePull(a: Pull, b: Pull): boolean {
    return (
      a.head.sha === b.head.sha && a.base.sha === b.base.sha && a.changed_files === b.changed_files
    );
  }

  /** The file pages read between two matching pull reads, or the newer pull when they differ. */
  async function readSnapshotAt(
    ref: ChangeRequestReadOptions,
    before: Pull,
  ): Promise<{ snapshot: Snapshot } | { changedTo: Pull }> {
    if (before.changed_files > GITHUB_FILE_LIMIT) {
      throw new ChangeRequestReadError(
        "too_large",
        "GitHub's file API only returns up to 3,000 files. Open this pull request on GitHub for the complete diff.",
      );
    }
    const key = `${refKey(ref)}@${before.head.sha}`;
    const cachedSnapshot = ref.force ? undefined : snapshots.get(key);
    if (cachedSnapshot) {
      return { snapshot: cachedSnapshot };
    }
    // Every page is known up front, so they load together; the limiter bounds the processes.
    const pageCount = Math.ceil(before.changed_files / FILES_PAGE_SIZE);
    const pages = await Promise.all(
      Array.from({ length: pageCount }, (_, index) => readFilesPage(ref, index + 1)),
    );
    const after = await readPull(ref, true);
    if (!samePull(before, after)) {
      return { changedTo: after };
    }
    const records = new Map<string, PatchRecord>();
    let patchBytes = 0;
    for (const file of pages.flat()) {
      if (records.has(file.filename)) {
        throw new ChangeRequestReadError(
          "stale_snapshot",
          "The file list changed while loading. Reload the pull request.",
        );
      }
      const record = toFileRecord(file);
      patchBytes += record.patch === null ? 0 : Buffer.byteLength(record.patch);
      records.set(record.path, record);
    }
    if (records.size !== before.changed_files) {
      throw new ChangeRequestReadError(
        "unavailable",
        "GitHub returned an incomplete file list. Reload the pull request.",
      );
    }
    if (patchBytes > SNAPSHOT_MAX_PATCH_BYTES) {
      throw new ChangeRequestReadError(
        "too_large",
        "This diff exceeds the 32 MB limit. Open it on the forge.",
      );
    }
    const snapshot: Snapshot = {
      baseSha: before.base.sha,
      headSha: before.head.sha,
      records: [...records.values()],
      byPath: records,
      patchBytes,
    };
    snapshots.set(key, snapshot);
    return { snapshot };
  }

  async function fetchSnapshot(ref: ChangeRequestReadOptions): Promise<Snapshot> {
    // The pull read the header just made brackets the page reads as well as a new one would: an
    // older "before" only widens the window the "after" read has to confirm. When they differ the
    // cached read may predate a push, so the pages are read once more from the newer revision.
    const first = await readSnapshotAt(ref, await readPull(ref, ref.force));
    if ("snapshot" in first) {
      return first.snapshot;
    }
    const second = await readSnapshotAt(ref, first.changedTo);
    if ("snapshot" in second) {
      return second.snapshot;
    }
    throw new ChangeRequestReadError(
      "stale_snapshot",
      "The pull request changed while loading. Reload it to review a consistent snapshot.",
    );
  }

  function loadSnapshot(ref: ChangeRequestReadOptions): Promise<Snapshot> {
    const key = `${refKey(ref)}:${ref.force === true}`;
    const existing = inFlightSnapshots.get(key);
    if (existing) {
      return existing;
    }
    const pending = fetchSnapshot(ref).finally(() => inFlightSnapshots.delete(key));
    inFlightSnapshots.set(key, pending);
    return pending;
  }

  async function fetchStatus(ref: ChangeRequestReadOptions): Promise<ChangeRequestStatus> {
    const variables = [
      "-f",
      `owner=${ref.owner}`,
      "-f",
      `name=${ref.name}`,
      "-F",
      `number=${ref.number}`,
    ];
    const query = (withChecks: boolean) =>
      `${STATUS_QUERY_HEAD}${withChecks ? STATUS_QUERY_CHECKS : ""}${STATUS_QUERY_TAIL}`;
    let checksError: string | null = null;
    let stdout: string;
    try {
      stdout = await gh(
        ["api", "graphql", "-f", `query=${query(true)}`, ...variables],
        ref.forgeHost,
      );
    } catch (error) {
      // Some tokens read the pull request but not its CI; keep the review state, mark checks unknown.
      if (!(error instanceof ChangeRequestReadError) || error.code !== "forbidden") {
        throw error;
      }
      checksError = "CI checks are unavailable with the current GitHub permissions.";
      stdout = await gh(
        ["api", "graphql", "-f", `query=${query(false)}`, ...variables],
        ref.forgeHost,
      );
    }
    const parsed = parseJson(stdout, StatusGraphqlSchema, "pull request status");
    const pr = parsed.data?.repository?.pullRequest;
    if (!pr) {
      throw new ChangeRequestReadError(
        "not_found",
        "This pull request is not available to your GitHub account.",
      );
    }
    const rollup = pr.latest?.nodes[0]?.commit?.statusCheckRollup ?? null;
    const checks = rollup ? deps.parseChecks(rollup.contexts.nodes.map(deps.toRollupNode)) : [];
    return {
      reviewDecision: deps.mapReviewDecision(pr.reviewDecision),
      viewerIsAuthor: pr.viewerDidAuthor,
      viewerLatestReview: mapViewerReview(pr.viewerLatestReview?.state),
      checks,
      checksStatus: computeChecksStatus(checks),
      checksError:
        rollup?.contexts.pageInfo.hasNextPage === true
          ? `Showing the first ${OVERVIEW_CHECK_CONTEXT_LIMIT} checks.`
          : checksError,
    };
  }

  async function fetchCommits(ref: ChangeRequestReadOptions): Promise<ChangeRequestCommitList> {
    const page = parseJson(
      await gh(
        [
          "api",
          "--method",
          "GET",
          `repos/${ref.owner}/${ref.name}/pulls/${ref.number}/commits`,
          "-F",
          `per_page=${COMMITS_PAGE_SIZE}`,
        ],
        ref.forgeHost,
      ),
      CommitsPageSchema,
      "commit list",
    );
    return {
      commits: page.map((entry): ChangeRequestCommit => {
        const [headline = "", ...rest] = entry.commit.message.split("\n");
        return {
          sha: entry.sha,
          headline,
          body: rest.join("\n").trim(),
          author: entry.author?.login ?? entry.commit.author?.name ?? null,
          committedAt: entry.commit.author?.date ?? null,
          url: entry.html_url,
        };
      }),
      // One page is read; a longer history is reported, never silently clipped.
      truncated: page.length >= COMMITS_PAGE_SIZE,
    };
  }

  function inboxItemFromSearch(
    forgeHost: string,
    item: z.infer<typeof SearchIssuesSchema>["items"][number],
  ): ChangeRequestInboxItem | null {
    const repository = REPOSITORY_FROM_API_URL.exec(item.repository_url);
    if (!repository || !item.pull_request) {
      return null;
    }
    return {
      forgeHost,
      owner: repository[1],
      name: repository[2],
      number: item.number,
      url: item.html_url,
      title: item.title,
      state: toState(item.state, Boolean(item.pull_request.merged_at)),
      isDraft: item.draft ?? false,
      author: item.user?.login ?? null,
      updatedAt: item.updated_at ?? null,
      baseRefName: null,
      headRefName: null,
      headSha: null,
      reviewDecision: null,
      checksStatus: null,
      reviewRequested: false,
      authoredByMe: false,
    };
  }

  async function readAccountScope(
    forgeHost: string,
    scope: "review_requested" | "authored",
    perPage: number,
  ): Promise<{ items: ChangeRequestInboxItem[]; truncated: boolean }> {
    const qualifier = scope === "review_requested" ? "review-requested:@me" : "author:@me";
    const result = parseJson(
      await gh(
        [
          "api",
          "--method",
          "GET",
          "search/issues",
          "-f",
          `q=is:pr is:open archived:false ${qualifier}`,
          "-f",
          "sort=updated",
          "-f",
          "order=desc",
          "-F",
          `per_page=${perPage}`,
        ],
        forgeHost,
      ),
      SearchIssuesSchema,
      "pull request search",
    );
    const items = result.items.flatMap((item) => {
      const mapped = inboxItemFromSearch(forgeHost, item);
      return mapped ? [mapped] : [];
    });
    return {
      items,
      truncated:
        (result.total_count ?? 0) > result.items.length || result.incomplete_results === true,
    };
  }

  async function readRepositoryScope(
    forgeHost: string,
    repository: { owner: string; name: string },
    perSource: number,
  ): Promise<{ items: ChangeRequestInboxItem[]; truncated: boolean }> {
    const fields =
      "number,url,title,state,isDraft,author,updatedAt,baseRefName,headRefName,headRefOid,reviewDecision,statusCheckRollup";
    const target = ["--repo", `${forgeHost}/${repository.owner}/${repository.name}`];
    let stdout: string;
    try {
      stdout = await gh(
        [
          "pr",
          "list",
          ...target,
          "--state",
          "open",
          "--limit",
          String(perSource),
          "--json",
          fields,
        ],
        forgeHost,
      );
    } catch (error) {
      if (!(error instanceof ChangeRequestReadError) || error.code !== "forbidden") {
        throw error;
      }
      stdout = await gh(
        [
          "pr",
          "list",
          ...target,
          "--state",
          "open",
          "--limit",
          String(perSource),
          "--json",
          fields.replace(",statusCheckRollup", ""),
        ],
        forgeHost,
      );
    }
    const list = parseJson(stdout, PrListSchema, "pull request list");
    return {
      items: list.map((item): ChangeRequestInboxItem => {
        const checks = Array.isArray(item.statusCheckRollup)
          ? deps.parseChecks(item.statusCheckRollup)
          : null;
        return {
          forgeHost,
          owner: repository.owner,
          name: repository.name,
          number: item.number,
          url: item.url,
          title: item.title,
          state: toState(item.state, false),
          isDraft: item.isDraft ?? false,
          author: item.author?.login ?? null,
          updatedAt: item.updatedAt ?? null,
          baseRefName: item.baseRefName ?? null,
          headRefName: item.headRefName ?? null,
          headSha: item.headRefOid ?? null,
          reviewDecision: deps.mapReviewDecision(item.reviewDecision),
          checksStatus: checks ? computeChecksStatus(checks) : null,
          reviewRequested: false,
          authoredByMe: false,
        };
      }),
      truncated: list.length >= perSource,
    };
  }

  function sourceError(
    scope: ChangeRequestInboxSource["scope"],
    repository: string | null,
    error: unknown,
  ) {
    const readError =
      error instanceof ChangeRequestReadError
        ? error
        : new ChangeRequestReadError("unavailable", "GitHub could not be read.");
    return {
      scope,
      repository,
      status: "error" as const,
      truncated: false,
      error: { code: readError.code, message: readError.message },
    };
  }

  return {
    async listChangeRequestInbox(options) {
      const sources: ChangeRequestInboxSource[] = [];
      const merged = new Map<string, ChangeRequestInboxItem>();
      const add = (items: ChangeRequestInboxItem[], flag?: "reviewRequested" | "authoredByMe") => {
        for (const item of items) {
          const key = item.url.toLowerCase();
          const existing = merged.get(key);
          const target = existing ?? item;
          if (flag) {
            target[flag] = true;
          }
          if (!existing) {
            merged.set(key, target);
          }
        }
      };
      const tasks: Array<() => Promise<void>> = [];
      for (const scope of options.scopes) {
        if (scope === "repository") {
          for (const repository of options.repositories) {
            const label = `${repository.owner}/${repository.name}`;
            tasks.push(async () => {
              try {
                const result = await readRepositoryScope(
                  options.forgeHost,
                  repository,
                  options.limit,
                );
                add(result.items);
                sources.push({
                  scope,
                  repository: label,
                  status: "ready",
                  truncated: result.truncated,
                  error: null,
                });
              } catch (error) {
                sources.push(sourceError(scope, label, error));
              }
            });
          }
        } else {
          tasks.push(async () => {
            try {
              const result = await readAccountScope(options.forgeHost, scope, options.limit);
              add(result.items, scope === "review_requested" ? "reviewRequested" : "authoredByMe");
              sources.push({
                scope,
                repository: null,
                status: "ready",
                truncated: result.truncated,
                error: null,
              });
            } catch (error) {
              sources.push(sourceError(scope, null, error));
            }
          });
        }
      }
      // The limiter bounds `gh` processes; this bounds how many tasks are queued at once.
      for (let index = 0; index < tasks.length; index += INBOX_REPOSITORY_CONCURRENCY) {
        await Promise.all(
          tasks.slice(index, index + INBOX_REPOSITORY_CONCURRENCY).map((task) => task()),
        );
      }
      return {
        items: [...merged.values()].sort(
          (a, b) =>
            Number(b.reviewRequested) - Number(a.reviewRequested) ||
            (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
        ),
        sources,
      };
    },

    async getChangeRequestOverview(options) {
      return buildOverview(options, await readPull(options, options.force));
    },

    getChangeRequestStatus(options) {
      return statuses.get(refKey(options), options.force, () => fetchStatus(options));
    },

    listChangeRequestCommits(options) {
      return commitLists.get(refKey(options), options.force, () => fetchCommits(options));
    },

    async listChangeRequestFiles(options) {
      const snapshot = await loadSnapshot(options);
      return {
        snapshot: {
          baseSha: snapshot.baseSha,
          headSha: snapshot.headSha,
          totalFiles: snapshot.records.length,
          patchBytesTotal: snapshot.patchBytes,
        },
        files: snapshot.records.map(toWireFile),
      };
    },

    async getChangeRequestFileDiffs(options) {
      const key = `${refKey(options)}@${options.headSha}`;
      let snapshot = snapshots.get(key);
      if (!snapshot) {
        snapshot = await loadSnapshot({ ...options, force: false });
        if (snapshot.headSha !== options.headSha) {
          throw new ChangeRequestReadError(
            "stale_snapshot",
            "The pull request has new commits. Reload it to review the latest changes.",
          );
        }
      }
      const known = snapshot;
      return {
        headSha: known.headSha,
        diffs: options.paths.map((path): ChangeRequestFileDiff => {
          const record = known.byPath.get(path);
          if (!record) {
            return {
              path,
              file: null,
              unavailable: "missing",
              message: "This file is not part of the pull request.",
            };
          }
          return toFileDiff(record);
        }),
      };
    },
  };
}
