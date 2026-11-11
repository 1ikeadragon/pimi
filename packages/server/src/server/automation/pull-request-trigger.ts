import { z } from "zod";
import type { AutomationPullRequestEvent, PullRequestEvent } from "@pimi/protocol/automation/types";

// Runs `gh` with the given arguments and returns stdout. Throws when gh is missing, not signed
// in, or the command fails.
export type GhRunner = (args: string[]) => Promise<string>;

export const PULL_REQUEST_POLL_INTERVAL_MS = 60_000;
const PR_LIST_LIMIT = "100";
// Head commits remembered per automation so a PR head fires once. Old ones drop off first.
const FIRED_HEADS_KEPT = 500;

const GhPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  headRefOid: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  isDraft: z.boolean(),
});

const GhPullRequestNumberSchema = z.object({ number: z.number().int().positive() });

// What the daemon remembers between polls of one automation's trigger. Stored at
// $PASEO_HOME/automations/triggers/<automationId>.json.
export const PullRequestTriggerStateSchema = z.object({
  id: z.string(),
  repo: z.string(),
  // Last seen head of each open PR, by number.
  heads: z.record(z.string(), z.string()),
  // Open PRs that asked the gh user for review at the last poll.
  reviewRequested: z.array(z.number().int()),
  // `<number>@<headSha>` of every head that already fired, oldest first.
  firedHeads: z.array(z.string()),
});
export type PullRequestTriggerState = z.infer<typeof PullRequestTriggerStateSchema>;

interface OpenPullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  headSha: string;
  headRef: string;
  baseRef: string;
}

async function listOpenPullRequests(gh: GhRunner, repo: string): Promise<OpenPullRequest[]> {
  const stdout = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    PR_LIST_LIMIT,
    "--json",
    "number,title,url,author,headRefOid,headRefName,baseRefName,isDraft",
  ]);
  const parsed = z.array(GhPullRequestSchema).parse(JSON.parse(stdout));
  // Drafts are not ready for anyone; they fire once they leave draft and change head or ask
  // for review.
  return parsed
    .filter((pr) => !pr.isDraft)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? "",
      headSha: pr.headRefOid,
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
    }));
}

// `review-requested:@me` covers requests to the user's teams too, which the PR's own
// reviewRequests list does not resolve.
async function listReviewRequestedNumbers(gh: GhRunner, repo: string): Promise<Set<number>> {
  const stdout = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    "review-requested:@me",
    "--limit",
    PR_LIST_LIMIT,
    "--json",
    "number",
  ]);
  const parsed = z.array(GhPullRequestNumberSchema).parse(JSON.parse(stdout));
  return new Set(parsed.map((pr) => pr.number));
}

export interface PullRequestPollResult {
  state: PullRequestTriggerState;
  events: AutomationPullRequestEvent[];
}

// One poll: compares the open PRs with the last poll and returns the events to fire. The first
// poll for a repo (no state, or state for another repo) only records what is open, so turning an
// automation on does not fire for every PR already waiting. A head that already fired never fires
// again, whichever event saw it first.
export async function pollPullRequests(input: {
  gh: GhRunner;
  automationId: string;
  repo: string;
  events: readonly PullRequestEvent[];
  previous: PullRequestTriggerState | null;
}): Promise<PullRequestPollResult> {
  const { repo, events } = input;
  const open = await listOpenPullRequests(input.gh, repo);
  const reviewRequested = events.includes("review_requested")
    ? await listReviewRequestedNumbers(input.gh, repo)
    : new Set<number>();
  const previous = input.previous?.repo === repo ? input.previous : null;
  const state: PullRequestTriggerState = {
    id: input.automationId,
    repo,
    heads: Object.fromEntries(open.map((pr) => [String(pr.number), pr.headSha])),
    reviewRequested: [...reviewRequested],
    firedHeads: [...(previous?.firedHeads ?? [])],
  };
  if (!previous) {
    return { state, events: [] };
  }
  const fired = new Set(state.firedHeads);
  const wasReviewRequested = new Set(previous.reviewRequested);
  const found: AutomationPullRequestEvent[] = [];
  for (const pr of open) {
    const key = `${pr.number}@${pr.headSha}`;
    if (fired.has(key)) {
      continue;
    }
    const lastHead = previous.heads[String(pr.number)];
    let action: PullRequestEvent | null = null;
    if (lastHead === undefined && events.includes("opened")) {
      action = "opened";
    } else if (
      lastHead !== undefined &&
      lastHead !== pr.headSha &&
      events.includes("synchronize")
    ) {
      action = "synchronize";
    } else if (reviewRequested.has(pr.number) && !wasReviewRequested.has(pr.number)) {
      action = "review_requested";
    }
    if (!action) {
      continue;
    }
    fired.add(key);
    state.firedHeads.push(key);
    found.push({
      kind: "pull_request",
      action,
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      headSha: pr.headSha,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
    });
  }
  state.firedHeads = state.firedHeads.slice(-FIRED_HEADS_KEPT);
  return { state, events: found };
}
