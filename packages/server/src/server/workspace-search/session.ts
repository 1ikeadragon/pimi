import type {
  WorkspaceSearchCancelRequest,
  WorkspaceSearchReplaceRequest,
  WorkspaceSearchRunRequest,
} from "@pimi/protocol/workspace-search";
import type { SessionOutboundMessage } from "../messages.js";
import { replaceInFiles } from "./replace.js";
import { WorkspaceSearchRuns } from "./search.js";

export interface WorkspaceSearchSessionOptions {
  emit(message: SessionOutboundMessage): void;
  /** The workspace root, or null when the workspace is unknown or archived. */
  resolveWorkspaceRoot(workspaceId: string): Promise<string | null>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `workspace.search.*` RPCs of one connection. */
export class WorkspaceSearchSession {
  private readonly runs: WorkspaceSearchRuns;

  constructor(private readonly options: WorkspaceSearchSessionOptions) {
    this.runs = new WorkspaceSearchRuns(options);
  }

  async handleRun(request: WorkspaceSearchRunRequest, signal: AbortSignal): Promise<void> {
    let outcome: Awaited<ReturnType<WorkspaceSearchRuns["run"]>>;
    try {
      outcome = await this.runs.run(request, signal);
    } catch (error) {
      outcome = { error: describe(error), stats: null };
    }
    // A closed connection has nobody to answer.
    if (signal.aborted) return;
    this.options.emit({
      type: "workspace.search.run.response",
      payload: { requestId: request.requestId, ...outcome },
    });
  }

  handleCancel(request: WorkspaceSearchCancelRequest): void {
    this.options.emit({
      type: "workspace.search.cancel.response",
      payload: { requestId: request.requestId, cancelled: this.runs.cancel(request) },
    });
  }

  async handleReplace(request: WorkspaceSearchReplaceRequest, signal: AbortSignal): Promise<void> {
    let outcome: Awaited<ReturnType<typeof replaceInFiles>>;
    try {
      const root = await this.options.resolveWorkspaceRoot(request.workspaceId);
      outcome = root
        ? await replaceInFiles(request, root, signal, (result) =>
            this.options.emit({
              type: "workspace.search.replace.update",
              payload: { requestId: request.requestId, result },
            }),
          )
        : { error: "This workspace is unavailable.", filesChanged: 0, replacements: 0 };
    } catch (error) {
      outcome = { error: describe(error), filesChanged: 0, replacements: 0 };
    }
    this.options.emit({
      type: "workspace.search.replace.response",
      payload: { requestId: request.requestId, ...outcome },
    });
  }
}
