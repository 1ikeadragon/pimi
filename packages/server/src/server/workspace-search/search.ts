import type {
  WorkspaceSearchCancelRequest,
  WorkspaceSearchFileMatches,
  WorkspaceSearchMatch,
  WorkspaceSearchRunRequest,
  WorkspaceSearchStats,
} from "@pimi/protocol/workspace-search";
import { WORKSPACE_SEARCH_LIMITS } from "@pimi/protocol/workspace-search";
import {
  createWorkspaceSearchRegExp,
  findMatchRanges,
} from "@pimi/protocol/search/workspace-search-pattern";
import { createRunGitCommand } from "../../utils/run-git-command.js";
import {
  describeGitGrepFailure,
  detectRegexDialect,
  runGitGrep,
  type RegexDialect,
} from "./git-grep.js";
import { buildPathspecs, toWorkspaceRelativePath } from "./pathspecs.js";

const runGit = createRunGitCommand("workspace-search");

const FLUSH_INTERVAL_MS = 50;
const FLUSH_MATCH_COUNT = 200;
const MAX_CONCURRENT_SEARCHES = 2;
const CONTEXT_BEFORE_MATCH = 40;

// Counts searches across every connection, so one client cannot pin all of the machine's cores.
let liveSearches = 0;

export function describeSearchQueryProblem(query: string): string | null {
  if (query.includes("\n") || query.includes("\r") || query.includes("\u0000"))
    return "Search matches one line at a time; remove the line break.";
  return null;
}

async function isInsideGitWorkTree(cwd: string, signal: AbortSignal): Promise<boolean> {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd,
    signal,
    acceptExitCodes: [0, 128],
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/** The window of `line` shown for a match, cut around the first one. */
function buildMatch(
  lineNumber: number,
  text: string,
  ranges: Array<[number, number]>,
): WorkspaceSearchMatch {
  const firstStart = ranges[0]?.[0] ?? 0;
  let start = Math.max(0, firstStart - CONTEXT_BEFORE_MATCH);
  if (start === 0) {
    const indent = /^\s*/.exec(text)?.[0].length ?? 0;
    if (indent <= firstStart) start = indent;
  }
  const end = Math.min(text.length, start + WORKSPACE_SEARCH_LIMITS.maxPreviewChars);
  return {
    line: lineNumber,
    preview: text.slice(start, end),
    previewOffset: start,
    ranges: ranges
      .filter(([rangeStart]) => rangeStart < end)
      .map(([rangeStart, rangeEnd]) => [rangeStart - start, Math.min(rangeEnd, end) - start]),
  };
}

export interface WorkspaceSearchHost {
  emit(message: {
    type: "workspace.search.run.update";
    payload: { requestId: string; files: WorkspaceSearchFileMatches[] };
  }): void;
  /** The workspace root, or null when the workspace is unknown or archived. */
  resolveWorkspaceRoot(workspaceId: string): Promise<string | null>;
}

interface ActiveSearch {
  controller: AbortController;
}

/** One connection's searches. A new run replaces the live one; cancel and close stop it. */
export class WorkspaceSearchRuns {
  private readonly active = new Map<string, ActiveSearch>();

  constructor(private readonly host: WorkspaceSearchHost) {}

  cancel(request: WorkspaceSearchCancelRequest): boolean {
    const search = this.active.get(request.targetRequestId);
    if (!search) return false;
    search.controller.abort();
    return true;
  }

  async run(
    request: WorkspaceSearchRunRequest,
    connectionSignal: AbortSignal,
  ): Promise<{ error: string | null; stats: WorkspaceSearchStats | null }> {
    const problem = describeSearchQueryProblem(request.query);
    if (problem) return { error: problem, stats: null };
    let pathspecs: string[];
    try {
      pathspecs = buildPathspecs(request.include, request.exclude);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), stats: null };
    }
    const root = await this.host.resolveWorkspaceRoot(request.workspaceId);
    if (!root) return { error: "This workspace is unavailable.", stats: null };

    for (const previous of this.active.values()) previous.controller.abort();
    if (liveSearches >= MAX_CONCURRENT_SEARCHES) {
      return { error: "Other searches are still running. Try again in a moment.", stats: null };
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, connectionSignal]);
    this.active.set(request.requestId, { controller });
    liveSearches += 1;
    try {
      return await this.search(request, root, pathspecs, controller, signal);
    } finally {
      liveSearches -= 1;
      this.active.delete(request.requestId);
    }
  }

  private async search(
    request: WorkspaceSearchRunRequest,
    root: string,
    pathspecs: string[],
    controller: AbortController,
    signal: AbortSignal,
  ): Promise<{ error: string | null; stats: WorkspaceSearchStats | null }> {
    const startedAt = performance.now();
    const regex = createWorkspaceSearchRegExp(request);
    const [inGitWorkTree, dialect] = await Promise.all([
      isInsideGitWorkTree(root, signal),
      request.isRegex ? detectRegexDialect() : Promise.resolve<RegexDialect | null>(null),
    ]);

    const stats = { files: 0, matches: 0, unlocated: 0 };
    let limitHit: WorkspaceSearchStats["limitHit"] = null;
    const seenFiles = new Set<string>();
    let pending = new Map<string, WorkspaceSearchMatch[]>();
    let pendingMatches = 0;

    const flush = () => {
      if (pending.size === 0) return;
      const files = [...pending].map(([path, matches]) => ({ path, matches }));
      pending = new Map();
      pendingMatches = 0;
      this.host.emit({
        type: "workspace.search.run.update",
        payload: { requestId: request.requestId, files },
      });
    };
    const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    const timeout = setTimeout(() => {
      limitHit = "time";
      controller.abort();
    }, WORKSPACE_SEARCH_LIMITS.timeoutMs);

    try {
      const result = await runGitGrep(
        {
          cwd: root,
          query: request.query,
          isRegex: request.isRegex,
          matchCase: request.matchCase,
          wholeWord: request.wholeWord,
          pathspecs,
          useIgnoreFiles: request.useIgnoreFiles,
          inGitWorkTree,
          dialect: dialect ?? "pcre",
          signal,
        },
        (record) => {
          const path = toWorkspaceRelativePath(record.path);
          if (path === null) return true;
          if (!seenFiles.has(path)) {
            if (seenFiles.size >= WORKSPACE_SEARCH_LIMITS.maxFiles) {
              limitHit = "files";
              return false;
            }
            seenFiles.add(path);
          }
          // CRLF files: the carriage return belongs to the line ending, not the line.
          const text = record.text.endsWith("\r") ? record.text.slice(0, -1) : record.text;
          const ranges = regex ? findMatchRanges(regex, text) : [];
          if (ranges.length === 0) stats.unlocated += 1;
          stats.matches += Math.max(1, ranges.length);
          const matches = pending.get(path);
          const match = buildMatch(record.line, text, ranges);
          if (matches) matches.push(match);
          else pending.set(path, [match]);
          pendingMatches += 1;
          if (pendingMatches >= FLUSH_MATCH_COUNT) flush();
          if (stats.matches >= WORKSPACE_SEARCH_LIMITS.maxMatches) {
            limitHit = "matches";
            return false;
          }
          return true;
        },
      );
      flush();
      stats.files = seenFiles.size;
      const finished: WorkspaceSearchStats = {
        ...stats,
        elapsedMs: Math.round(performance.now() - startedAt),
        limitHit,
        cancelled: signal.aborted && limitHit === null,
        regexDialect: dialect,
      };
      // Exit 1 is "no matches". Anything else without our own stop is git refusing the search.
      if (!result.stopped && result.exitCode !== 0 && result.exitCode !== 1) {
        return { error: describeGitGrepFailure(result.stderr), stats: finished };
      }
      return { error: null, stats: finished };
    } finally {
      clearInterval(flushTimer);
      clearTimeout(timeout);
    }
  }
}
