import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface WorkspaceSetupResult {
  workspaceId: string;
  status: "started" | "already_allowed";
}

const workspaceSetupSchema: OutputSchema<WorkspaceSetupResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "STATUS", field: "status", width: 18 },
  ],
};

export async function runSetupCommand(
  workspaceId: string,
  options: { host?: string; daemonTarget: import("../../utils/daemon-target.js").DaemonTarget },
  _command: Command,
): Promise<SingleResult<WorkspaceSetupResult>> {
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies CommandError;
  });
  try {
    const payload = await client.runWorkspaceSetup(workspaceId);
    if (payload.error) throw new Error(payload.error);
    return {
      type: "single",
      data: { workspaceId, status: payload.started ? "started" : "already_allowed" },
      schema: workspaceSetupSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_SETUP_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
