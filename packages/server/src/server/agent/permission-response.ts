import type { Logger } from "pino";
import { buildToolCallDisplayModel } from "@pimi/protocol/tool-call-display";

import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentTimelineItem,
} from "./agent-sdk-types.js";
import { startAgentRun, type AgentRunController } from "./agent-prompt.js";

export interface PermissionResponseAgentManager extends AgentRunController {
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
  appendTimelineItem(agentId: string, item: AgentTimelineItem): Promise<unknown>;
}

/** Who answered the prompt: another agent through its tools, a connected client, or a tool caller that is not an agent. */
export type PermissionResponder =
  | { kind: "agent"; agentId: string; title: string }
  | { kind: "client" }
  | { kind: "tool" };

export interface RespondToAgentPermissionParams {
  agentManager: PermissionResponseAgentManager;
  agentId: string;
  requestId: string;
  response: AgentPermissionResponse;
  responder: PermissionResponder;
  logger: Logger;
}

export interface PermissionResponseOutcome {
  decision: AgentPermissionResponse["behavior"];
  /** Null when the request was no longer pending on the agent when the response arrived. */
  request: PermissionRequestDescription | null;
}

interface PermissionRequestDescription {
  kind: AgentPermissionRequest["kind"];
  tool: string;
  summary?: string;
}

type PermissionResolutionTimelineItem = Extract<AgentTimelineItem, { type: "notification" }>;

function describePermissionRequest(
  request: AgentPermissionRequest,
  cwd: string,
): PermissionRequestDescription {
  const display = buildToolCallDisplayModel({
    name: request.name,
    status: "running",
    error: null,
    detail: request.detail ?? { type: "unknown", input: request.input ?? null, output: null },
    cwd,
  });
  return {
    kind: request.kind,
    // A request with no canonical detail falls back to its raw tool name; its title reads better.
    tool: request.detail ? display.displayName : (request.title ?? display.displayName),
    ...(display.summary ? { summary: display.summary } : {}),
  };
}

/** The message is what a client without marker rendering shows. */
function buildPermissionResolutionTimelineItem(params: {
  decision: AgentPermissionResponse["behavior"];
  request: PermissionRequestDescription;
  responder: Extract<PermissionResponder, { kind: "agent" }>;
}): PermissionResolutionTimelineItem {
  const { decision, request, responder } = params;
  const verb = decision === "allow" ? "Allowed" : "Denied";
  const subject = request.summary ? `${request.tool} ${request.summary}` : request.tool;
  return {
    type: "notification",
    level: "info",
    message: `${verb} by ${responder.title} · ${subject}`,
    permissionResolution: {
      decision,
      ...request,
      resolvedBy: { agentId: responder.agentId, title: responder.title },
    },
  };
}

export async function respondToAgentPermission(
  params: RespondToAgentPermissionParams,
): Promise<PermissionResponseOutcome> {
  const { agentManager, agentId, requestId, response, responder, logger } = params;
  // Read before responding: the request leaves the pending set once it is answered.
  const target = agentManager.getAgent(agentId);
  const pending = target?.pendingPermissions.get(requestId);
  const request = target && pending ? describePermissionRequest(pending, target.cwd) : null;

  const result = await agentManager.respondToPermission(agentId, requestId, response);
  logger.info(
    {
      agentId,
      requestId,
      decision: response.behavior,
      responder: responder.kind,
      ...(responder.kind === "agent" ? { responderAgentId: responder.agentId } : {}),
      toolName: pending?.name,
      ...(request?.summary ? { summary: request.summary } : {}),
    },
    "agent.permission.resolved",
  );

  // The agent's own chat is where a client answers, so only another agent's answer needs a note.
  if (request && responder.kind === "agent" && responder.agentId !== agentId) {
    await agentManager.appendTimelineItem(
      agentId,
      buildPermissionResolutionTimelineItem({ decision: response.behavior, request, responder }),
    );
  }

  if (result?.followUpPrompt) {
    logger.debug({ agentId }, "Permission response requires follow-up turn, starting agent stream");
    await startAgentRun(agentManager, agentId, result.followUpPrompt, logger, {
      replaceRunning: true,
    });
  }
  return { decision: response.behavior, request };
}
