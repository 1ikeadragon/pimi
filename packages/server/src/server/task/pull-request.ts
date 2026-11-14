import type { TaskPullRequest, TaskPullRequestState } from "@pimi/protocol/task/types";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

function stateOf(
  pr: NonNullable<WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"]>,
): TaskPullRequestState {
  if (pr.isMerged) return "merged";
  if (pr.state.toLowerCase() === "closed") return "closed";
  return pr.isDraft ? "draft" : "open";
}

/** A checkout's forge PR reduced to what the Tasks UI shows. */
export function toTaskPullRequest(
  pr: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"],
): TaskPullRequest | null {
  if (!pr?.url) return null;
  return {
    url: pr.url,
    ...(pr.number === undefined ? {} : { number: pr.number }),
    title: pr.title,
    state: stateOf(pr),
  };
}
