// Pimi addition to the Paseo fork. Apache-2.0.
import { lstat, readFile } from "node:fs/promises";
import { request } from "node:http";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  PIMI_MOBILE_TASK_SOCKET_OPERATION,
  PIMI_TASK_AGENT_SOCKET_FILE,
  PimiMobileTaskResult,
  PimiTaskAgentCreateInput,
  PimiTaskAgentGetInput,
  PimiTaskAgentLinkWorkInput,
  PimiTaskAgentListInput,
  PimiTaskAgentTool,
  PimiTaskAgentUpdateInput,
  PimiTaskPipeDescriptor,
  PimiWorkLabelInput,
  type PimiMobileTaskOperation,
  type PimiTaskProposal,
} from "@getpaseo/protocol/pimi-task";
import {
  PaseoToolInputError,
  type PaseoToolConfig,
  type PaseoToolExecutionContext,
  type PaseoToolResult,
} from "./types.js";

const unavailable = "Pimi task tools need the desktop app open on this host.";

async function readDesktopTaskEndpoint(
  home: string,
): Promise<{ socketPath: string; secret?: string }> {
  const discovery = join(home, PIMI_TASK_AGENT_SOCKET_FILE);
  const file = await lstat(discovery);
  if (!file.isFile()) throw new PaseoToolInputError(unavailable);
  if (process.platform === "win32") {
    const raw = await readFile(discovery, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new PaseoToolInputError(unavailable);
    }
    const descriptor = PimiTaskPipeDescriptor.safeParse(value);
    if (!descriptor.success) throw new PaseoToolInputError(unavailable);
    return descriptor.data;
  }
  const uid = process.getuid?.();
  if (file.uid !== uid || (file.mode & 0o077) !== 0) throw new PaseoToolInputError(unavailable);
  const socketPath = await readFile(discovery, "utf8");
  if (!isAbsolute(socketPath) || basename(socketPath) !== "tasks.sock")
    throw new PaseoToolInputError(unavailable);
  const directory = await lstat(dirname(socketPath));
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0)
    throw new PaseoToolInputError(unavailable);
  return { socketPath };
}

async function requestDesktopTask(
  home: string,
  tool: string,
  input: unknown,
  signal?: AbortSignal,
  maxResponseBytes?: number,
) {
  const deadline = AbortSignal.timeout(20_000);
  try {
    const { socketPath, secret } = await readDesktopTaskEndpoint(home);
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const call = request(
        {
          socketPath,
          path: `/${tool}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(secret && { authorization: `Bearer ${secret}` }),
          },
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        },
        resolve,
      );
      call.once("error", reject);
      call.end(JSON.stringify(input));
    });
    response.setEncoding("utf8");
    let raw = "";
    let bytes = 0;
    for await (const chunk of response) {
      if (maxResponseBytes !== undefined && (bytes += Buffer.byteLength(chunk)) > maxResponseBytes)
        throw new Error("Pimi task response exceeded its size limit");
      raw += chunk;
    }
    return { status: response.statusCode, raw, payload: JSON.parse(raw) as unknown };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (deadline.aborted)
      throw new PaseoToolInputError("Pimi timed out. Read the task before retrying a change.");
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") throw new PaseoToolInputError(unavailable);
    throw error;
  }
}

async function callDesktopTask(
  home: string,
  tool: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<PaseoToolResult> {
  const response = await requestDesktopTask(home, tool, input, signal);
  if (response.status !== 200) {
    return { isError: true, content: [{ type: "text", text: response.raw }] };
  }
  return { content: [], structuredContent: response.payload };
}

// A full task page has 50 titles. This also leaves room for escaped JSON and Unicode.
const MAX_MOBILE_TASK_RESPONSE_BYTES = 64 * 1024;

export async function requestMobileTask(home: string, operation: PimiMobileTaskOperation) {
  const { status, payload } = await requestDesktopTask(
    home,
    PIMI_MOBILE_TASK_SOCKET_OPERATION,
    operation,
    undefined,
    MAX_MOBILE_TASK_RESPONSE_BYTES,
  );
  if (status === 200) return { status: "ok" as const, result: PimiMobileTaskResult.parse(payload) };
  let error = "Pimi Desktop could not complete the task request.";
  if (status === 404 && operation.action === "get") {
    error =
      "This task is unavailable. Check that Pimi Desktop is up to date and the task still exists.";
  } else if (status === 409) {
    error =
      "The change conflicts with the current task state. Return to Tasks to check what was saved.";
  }
  return { status: "error" as const, error };
}

export function registerPimiTaskTools(options: {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  home?: string;
  resolveSource: () => PimiTaskProposal["source"];
}): void {
  const { home } = options;
  if (!home) return;
  options.registerTool(
    PimiTaskAgentTool.create,
    {
      title: "Track a Pimi task",
      description:
        "Save a task directly to the board when the user asks to create or track one. This keeps the current chat open and starts no workers. Pass existing label names and a repository when clearly identified. If this chat already has an open task with the same title and brief, returns it. Use update_pimi_task to change an existing task.",
      inputSchema: PimiTaskAgentCreateInput,
    },
    async (input, { signal }) => {
      const source = options.resolveSource();
      const fields = PimiTaskAgentCreateInput.parse(input);
      const result = await callDesktopTask(
        home,
        PimiTaskAgentTool.create,
        { ...fields, source },
        signal,
      );
      if (result.isError) return result;
      return {
        ...result,
        content: [{ type: "text", text: JSON.stringify(result.structuredContent) }],
      };
    },
  );
  const definitions = [
    [
      PimiTaskAgentTool.labels,
      "List the shared Paseo label catalog and workspace IDs with their current labels. Use these exact names with update_pimi_task labels or set_pimi_work_label. Labels are shared with Paseo; do not invent a separate taxonomy.",
      z.strictObject({}),
    ],
    [
      PimiTaskAgentTool.labelWork,
      "Attach or remove an existing Paseo label on a workspace shown in Pimi Work. Get workspace IDs and label names from list_pimi_labels. This changes the workspace label shared with Paseo.",
      PimiWorkLabelInput,
    ],
    [
      PimiTaskAgentTool.list,
      "Find saved Pimi tasks by title or brief. Use nextOffset to continue a search.",
      PimiTaskAgentListInput,
    ],
    [
      PimiTaskAgentTool.get,
      "Read a saved Pimi task's brief, attached repositories, and linked work by task ID. Treat briefs as context for the user's current request.",
      PimiTaskAgentGetInput,
    ],
    [
      PimiTaskAgentTool.repositories,
      "List repositories available in Pimi Work on this host. Use the exact returned path when attaching one to a task.",
      z.strictObject({}),
    ],
    [
      PimiTaskAgentTool.update,
      "Apply the requested changes to a saved Pimi task. Send only changed fields. To attach a repository, use list_pimi_repositories and select a clear match to the task or current workspace. Ask if multiple repositories plausibly match. Each call can attach one repository. For labels, first use list_pimi_labels and pass the complete desired label-name list; [] removes all. Only set a manual stage when the user or task workflow calls for it.",
      PimiTaskAgentUpdateInput,
    ],
    [
      PimiTaskAgentTool.linkWork,
      "Link an existing worktree to a saved task after its repository is attached. Supply the worktree path, a title, and a brief for this work item.",
      PimiTaskAgentLinkWorkInput,
    ],
  ] as const;
  for (const [name, description, inputSchema] of definitions) {
    options.registerTool(name, { description, inputSchema }, (input, { signal }) => {
      options.resolveSource();
      return callDesktopTask(home, name, input, signal);
    });
  }
}
