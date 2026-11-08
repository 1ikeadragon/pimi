// Pimi addition to the Paseo fork. Apache-2.0.
import { command, repositoryRemotes, RequestError } from "./git.mjs";

// Explicit UI limits bound network work and retained data; reaching one is reported.
const limits = { perSource: 100, repositories: 24, concurrency: 3 };
const refreshInterval = 60_000;
const fields =
  "number,url,title,state,isDraft,author,updatedAt,baseRefName,headRefName,headRefOid,reviewDecision,mergeable";
const statusFields = `${fields},statusCheckRollup`;
const detailFields = `${statusFields},body,additions,deletions,changedFiles`;

function githubRepository(remote) {
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(
      remote,
    );
  return match?.[1] ?? null;
}

function pullRequestIdentity(url) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url);
  if (!match || !Number.isSafeInteger(Number(match[2])))
    throw new RequestError("Choose a GitHub pull request URL.");
  return {
    repository: match[1],
    number: Number(match[2]),
    url: `https://github.com/${match[1]}/pull/${match[2]}`,
  };
}

function unavailable(error) {
  // CLI stderr can contain remote credentials or provider response text. Only
  // classify it here; expose actionable fixed messages to the renderer.
  const message = error.message || "";
  if (/gh is unavailable/.test(message))
    return {
      status: "cli_missing",
      error: "GitHub CLI is unavailable. Install gh to load pull requests.",
    };
  if (
    /auth login|authentication|not logged|invalid.*token|expired.*token|HTTP 401|Bad credentials/i.test(
      message,
    )
  )
    return {
      status: "unauthenticated",
      error: "GitHub authentication is unavailable. Run gh auth login for github.com.",
    };
  if (/HTTP 403|HTTP 429|rate limit/i.test(message))
    return {
      status: "error",
      error:
        "GitHub denied this request or its rate limit was reached. Check access and try again later.",
    };
  if (
    /HTTP 404|Could not resolve to a PullRequest|Could not resolve to a Repository/i.test(message)
  )
    return {
      status: "error",
      error: "This repository or pull request is unavailable to your GitHub account.",
    };
  if (/time or output limit/.test(message))
    return {
      status: "error",
      error: "GitHub exceeded the request time or output limit. Try refreshing later.",
    };
  return {
    status: "error",
    error:
      "GitHub metadata could not be loaded. Check your connection and GitHub access, then refresh.",
  };
}

function checkStatus(check) {
  if (check.__typename === "StatusContext") {
    return { SUCCESS: "success", FAILURE: "failure", ERROR: "failure" }[check.state] ?? "pending";
  }
  if (check.status !== "COMPLETED") return "pending";
  return (
    {
      SUCCESS: "success",
      FAILURE: "failure",
      TIMED_OUT: "failure",
      ACTION_REQUIRED: "failure",
      CANCELLED: "cancelled",
      SKIPPED: "skipped",
      NEUTRAL: "skipped",
    }[check.conclusion] ?? "pending"
  );
}

function summarizeChecks(checks, known) {
  if (!known) return "unknown";
  if (!checks.length) return "none";
  // Cancelled runs remain visible instead of being summarized as passing.
  if (checks.some((check) => ["failure", "cancelled"].includes(check.status))) return "failure";
  if (checks.some((check) => check.status === "pending")) return "pending";
  return "success";
}

function normalize(raw, extras = {}) {
  const identity = pullRequestIdentity(raw.url ?? raw.html_url);
  const knownChecks = Array.isArray(raw.statusCheckRollup);
  const checks = knownChecks
    ? raw.statusCheckRollup.map((check) => ({
        name: check.name ?? check.context ?? "Unnamed check",
        status: checkStatus(check),
        url: check.detailsUrl ?? check.targetUrl ?? null,
        workflow: check.workflowName ?? null,
      }))
    : [];
  return {
    id: identity.url,
    ...identity,
    title: raw.title,
    state: String(raw.state ?? "unknown").toLowerCase(),
    isDraft: raw.isDraft ?? raw.draft ?? false,
    author: raw.author?.login ?? raw.user?.login ?? null,
    updatedAt: raw.updatedAt ?? raw.updated_at ?? null,
    baseRefName: raw.baseRefName ?? null,
    headRefName: raw.headRefName ?? null,
    headSha: raw.headRefOid ?? null,
    mergeable: raw.mergeable ?? "UNKNOWN",
    reviewDecision:
      { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "pending" }[
        raw.reviewDecision
      ] ?? null,
    checks,
    checksStatus: summarizeChecks(checks, knownChecks),
    reviewRequested: false,
    worktreePaths: [],
    ...extras,
  };
}

export function createPullRequests({ getInventory, onChange = () => {} }) {
  let snapshot = {
    items: [],
    repositories: [],
    requestedReview: { status: "loading", truncated: false },
    updatedAt: null,
    warnings: [],
    limits,
  };
  let refreshTask;
  let attemptedAt = 0;
  let closed = false;
  let active = 0;
  const waiting = [];
  const details = new Map();

  async function gh(args, cwd) {
    if (active >= limits.concurrency) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try {
      if (closed) throw new RequestError("Pimi Review is closed.", 503);
      return JSON.parse(await command("gh", args, cwd, { timeout: 12_000, maxBuffer: 8 << 20 }));
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  async function readPr(args, requestedFields) {
    try {
      return { data: await gh([...args, "--json", requestedFields]) };
    } catch (error) {
      // Some tokens can read PRs but not CI. Preserve the PR and expose unknown checks.
      if (!/statusCheckRollup|Resource not accessible|insufficient.*scope/i.test(error.message))
        throw error;
      return {
        data: await gh([...args, "--json", requestedFields.replace(",statusCheckRollup", "")]),
        checksError: "CI checks are unavailable with the current GitHub permissions.",
      };
    }
  }

  async function refresh() {
    const previous = snapshot;
    const inventory = await getInventory();
    const warnings = [];
    if (inventory.daemonError) warnings.push(inventory.daemonError);
    if (inventory.repositories.length > limits.repositories)
      warnings.push(
        `Only the first ${limits.repositories} tracked local repositories were inspected. Add a PR URL to review another repository.`,
      );
    const sources = new Map();
    const repositories = [];
    // Discovery uses the same process bound as network reads, not unbounded Promise.all.
    const roots = inventory.repositories.slice(0, limits.repositories);
    for (let index = 0; index < roots.length; index += limits.concurrency) {
      await Promise.all(
        roots.slice(index, index + limits.concurrency).map(async ({ path, name }) => {
          try {
            const remotes = await repositoryRemotes(path);
            const github = [
              ...new Set(remotes.map(({ url }) => githubRepository(url)).filter(Boolean)),
            ];
            if (!github.length)
              repositories.push({
                path,
                name,
                status: "unsupported",
                error:
                  "No github.com remote. Paste a GitHub PR URL or continue with local changes.",
              });
            for (const repository of github) {
              const key = repository.toLowerCase();
              const source = sources.get(key) ?? { repository, paths: [] };
              source.paths.push(path);
              sources.set(key, source);
            }
          } catch (error) {
            repositories.push({ path, name, ...unavailable(error) });
          }
        }),
      );
    }
    if (sources.size > limits.repositories) {
      warnings.push(
        `Only the first ${limits.repositories} distinct GitHub repositories were queried.`,
      );
      for (const key of [...sources.keys()].slice(limits.repositories)) sources.delete(key);
    }
    const requestedTask = gh([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "search/issues",
      "-f",
      "q=is:pr is:open review-requested:@me",
      "-f",
      "sort=updated",
      "-f",
      "order=desc",
      "-f",
      `per_page=${limits.perSource}`,
    ])
      .then((data) => {
        if (!Array.isArray(data.items))
          throw new Error("GitHub returned an invalid review request list.");
        return {
          items: data.items.map((item) => normalize(item, { reviewRequested: true })),
          status: "ready",
          truncated: data.total_count > data.items.length || Boolean(data.incomplete_results),
        };
      })
      .catch((error) => ({
        items: previous.items
          .filter((item) => item.reviewRequested)
          .map((item) => Object.assign({}, item, { stale: true })),
        ...unavailable(error),
        truncated: previous.requestedReview.truncated,
      }));
    const items = [];
    for (const source of sources.values()) {
      // Enqueued together below through a small worker pool.
      source.worktreePaths = inventory.cards
        .filter((card) => source.paths.includes(card.root) && !card.unavailable)
        .map((card) => card.path);
      if (!source.worktreePaths.length) source.worktreePaths = source.paths;
    }
    const pending = [...sources.values()];
    await Promise.all(
      Array.from({ length: Math.min(limits.concurrency, pending.length) }, async () => {
        while (pending.length) {
          const source = pending.shift();
          try {
            const { data, checksError } = await readPr(
              [
                "pr",
                "list",
                "--repo",
                `github.com/${source.repository}`,
                "--state",
                "open",
                "--limit",
                String(limits.perSource),
              ],
              statusFields,
            );
            if (!Array.isArray(data)) throw new Error("GitHub returned an invalid PR list.");
            items.push(
              ...data.map((raw) =>
                normalize(raw, {
                  worktreePaths: source.worktreePaths,
                  ...(checksError ? { checksError } : {}),
                }),
              ),
            );
            repositories.push({
              ...source,
              status: "ready",
              truncated: data.length >= limits.perSource,
              ...(checksError ? { error: checksError } : {}),
            });
          } catch (error) {
            const staleItems = previous.items.filter(
              (item) => item.repository.toLowerCase() === source.repository.toLowerCase(),
            );
            items.push(
              ...staleItems.map((item) => ({
                ...item,
                worktreePaths: source.worktreePaths,
                stale: true,
              })),
            );
            repositories.push({
              ...source,
              ...unavailable(error),
              stale: Boolean(staleItems.length),
            });
          }
        }
      }),
    );
    const requested = await requestedTask;
    const merged = new Map(items.map((item) => [item.url.toLowerCase(), item]));
    for (const item of requested.items) {
      const existing = merged.get(item.url.toLowerCase());
      if (existing) existing.reviewRequested = true;
      else merged.set(item.url.toLowerCase(), item);
    }
    const { items: _requestedItems, ...requestedReview } = requested;
    snapshot = {
      items: [...merged.values()].sort(
        (a, b) =>
          Number(b.reviewRequested) - Number(a.reviewRequested) ||
          (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
      ),
      repositories,
      requestedReview,
      updatedAt: new Date().toISOString(),
      warnings,
      limits,
    };
  }

  function queue({ force = false } = {}) {
    if (
      !closed &&
      !refreshTask &&
      (!attemptedAt || Date.now() - attemptedAt >= refreshInterval || force)
    ) {
      attemptedAt = Date.now();
      refreshTask = refresh()
        .catch((error) => {
          snapshot = { ...snapshot, warnings: [unavailable(error).error], stale: true };
        })
        .finally(() => {
          refreshTask = undefined;
          if (!closed) onChange();
        });
    }
    return {
      ...snapshot,
      refreshing: Boolean(refreshTask),
      stale: Boolean(
        snapshot.stale ||
        snapshot.items.some((item) => item.stale) ||
        (snapshot.updatedAt && Date.now() - Date.parse(snapshot.updatedAt) >= refreshInterval),
      ),
    };
  }

  async function detail(url, { force = false } = {}) {
    const identity = pullRequestIdentity(url);
    const key = identity.url.toLowerCase();
    let entry = details.get(key);
    if (!entry) {
      // Evict completed entries only; active requests must stay coalesced.
      if (details.size >= 64) {
        const removable = [...details].find(([, value]) => !value.task);
        if (!removable)
          throw new RequestError("Too many PR details are loading. Try again shortly.", 429);
        details.delete(removable[0]);
      }
      entry = {};
      details.set(key, entry);
    }
    if (entry.task) return entry.task;
    if (!force && entry.result && Date.now() - entry.at < refreshInterval) return entry.result;
    entry.task = (async () => {
      try {
        const { data, checksError } = await readPr(
          ["pr", "view", String(identity.number), "--repo", `github.com/${identity.repository}`],
          detailFields,
        );
        const known = snapshot.items.find((item) => item.url.toLowerCase() === key);
        const item = normalize(data, {
          body: data.body ?? "",
          additions: data.additions,
          deletions: data.deletions,
          changedFiles: data.changedFiles,
          worktreePaths: known?.worktreePaths ?? [],
          reviewRequested: known?.reviewRequested ?? false,
          ...(checksError ? { checksError } : {}),
        });
        entry.result = {
          item,
          updatedAt: new Date().toISOString(),
          stale: false,
          ...(checksError ? { error: checksError } : {}),
        };
      } catch (error) {
        entry.result = {
          item:
            entry.result?.item ??
            snapshot.items.find((item) => item.url.toLowerCase() === key) ??
            null,
          updatedAt: entry.result?.updatedAt ?? null,
          stale: true,
          ...unavailable(error),
        };
      }
      entry.at = Date.now();
      return entry.result;
    })().finally(() => {
      entry.task = undefined;
    });
    return entry.task;
  }

  return {
    queue,
    detail,
    close() {
      closed = true;
    },
  };
}
