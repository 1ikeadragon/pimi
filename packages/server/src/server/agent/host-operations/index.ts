import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { parentAddressLabels } from "@pimi/protocol/agent-labels";
import type { ActiveTurnBehavior, AgentSnapshotPayload } from "@pimi/protocol/messages";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DaemonClient,
  DaemonConnectionError,
  type FetchWorkspacesEntry,
  type WaitForFinishResult,
} from "@pimi/client/internal/daemon-client";
import type { DaemonTransportFactory } from "@pimi/client/internal/daemon-client-transport-types";
import type { HostDirectory } from "@pimi/protocol/hosts";
import type { ConnectedHosts } from "../../connected-hosts/index.js";
import { resolveRequiredProviderModel } from "../mcp-shared.js";
import { selectAgentListItems } from "../agent-projections.js";
import { summarizeAgentActivity } from "../activity-curator.js";
import {
  inheritAgentBackground,
  inheritWorkspaceBackground,
  type BackgroundCaller,
} from "../create-agent/intent.js";
import { expandUserPath } from "../../path-utils.js";
import { limitModelList, toProviderSummary } from "../tools/provider-listing.js";
import {
  PimiToolInputError,
  type PimiToolExecutionContext,
  type PimiToolResult,
} from "../tools/types.js";

export class HostOperationRejectedError extends Error {
  readonly code: unknown;
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "HostOperationRejectedError";
    this.code = error instanceof Error && "code" in error ? error.code : undefined;
  }
}
function isAmbiguousPromptFailure(error: unknown): boolean {
  if (error instanceof DaemonConnectionError) return true;
  return error instanceof Error && error.message.startsWith("Timeout waiting for message");
}
export type HostOperation = (
  input: Record<string, unknown>,
  context: PimiToolExecutionContext,
) => Promise<PimiToolResult>;
export interface HostOperations {
  createAgent: HostOperation;
  createWorkspace: HostOperation;
  listWorkspaces: HostOperation;
  sendPrompt: HostOperation;
  getStatus: HostOperation;
  getActivity: HostOperation;
  listAgents: HostOperation;
  listProviders: HostOperation;
  listModels: HostOperation;
  cancelAgent: HostOperation;
  archiveAgent: HostOperation;
}
/** Connection authority at the host boundary, independent of child lifecycle. */
export class HostObservationError extends Error {
  constructor(
    readonly reason: "connecting" | "unreachable" | "removed",
    cause?: unknown,
  ) {
    super(`Host observation ${reason}`, { cause });
    this.name = "HostObservationError";
  }
}
export interface HostObservation {
  wait(agentId: string, signal: AbortSignal): Promise<WaitForFinishResult>;
  observe(
    agentId: string,
    handler: (
      snapshot: AgentSnapshotPayload | null,
      event?: AgentStreamEvent,
      lastMessage?: string | null,
    ) => void,
    signal: AbortSignal,
    onError: (error: unknown) => void,
  ): Promise<() => Promise<void>>;
}
export interface ToolHosts {
  directory(): Promise<HostDirectory>;
  use<T>(
    serverId: string,
    action: (client: DaemonClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

/** Daemon MCP has the daemon's authority, bounded by the destination's admission of its link. */
export function createToolHosts(hosts: ConnectedHosts): ToolHosts {
  return {
    directory: () => hosts.list(),
    async use(serverId, action, signal) {
      const lifetime = new AbortController();
      let routeFailure: unknown;
      const transportFactory: DaemonTransportFactory = () => {
        const opens = new Set<() => void>();
        const closes = new Set<(event?: unknown) => void>();
        const errors = new Set<(event: unknown) => void>();
        const messages = new Set<(data: unknown, binary: boolean) => void>();
        let closed = false;
        let route: Awaited<ReturnType<ConnectedHosts["openRoute"]>> | undefined;
        void hosts
          .openRoute({
            serverId,
            scopeId: randomUUID(),
            sourceId: "mcp",
            originSessionId: "mcp",
            signal: signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
            frame: (data) => {
              for (const listener of messages) listener(data, typeof data !== "string");
            },
            ended: (code, message) => {
              for (const listener of errors)
                listener(Object.assign(new Error(message), { code, serverId }));
              for (const listener of closes) listener();
            },
          })
          .then((opened) => {
            route = opened;
            if (closed) opened.close();
            else for (const listener of opens) listener();
            return undefined;
          })
          .catch((error) => {
            routeFailure = error;
            for (const listener of errors) listener(error);
            for (const listener of closes) listener(error);
          });
        return {
          send: (data) => {
            if (!route) throw new Error("Host route is not open");
            route.send(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
          },
          close: () => {
            closed = true;
            route?.close();
          },
          onOpen: (listener) => {
            opens.add(listener);
            return () => opens.delete(listener);
          },
          onClose: (listener) => {
            closes.add(listener);
            return () => closes.delete(listener);
          },
          onError: (listener) => {
            errors.add(listener);
            return () => errors.delete(listener);
          },
          onMessage: (listener) => {
            messages.add(listener);
            return () => messages.delete(listener);
          },
        };
      };
      const client = new DaemonClient({
        url: "ws://host-route/ws",
        clientId: randomUUID(),
        transportFactory,
        reconnect: { enabled: false },
      });
      const stop = () => void client.close();
      signal?.addEventListener("abort", stop, { once: true });
      try {
        signal?.throwIfAborted();
        await client.connect().catch((error) => {
          // The action has not run; no application request could have been transmitted.
          throw new HostOperationRejectedError(routeFailure ?? error);
        });
        return await action(client);
      } finally {
        signal?.removeEventListener("abort", stop);
        lifetime.abort();
        await client.close();
      }
    },
  };
}

const remoteCreate = z.object({
  provider: z.string().min(1),
  title: z.string().trim().min(1).max(60),
  initialPrompt: z.string().min(1),
  workspaceId: z.string().min(1),
  labels: z.record(z.string(), z.string()).optional(),
  notifyOnFinish: z.boolean().optional(),
  background: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
  settings: z
    .object({
      modeId: z.string().optional(),
      thinkingOptionId: z.string().optional(),
      features: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
const REMOTE_CREATE_REQUIRES =
  "On another host create_agent needs workspaceId and provider, and does not accept inheritContext, profile or cwd.";

/** Names every key the destination path cannot honor, so the agent can correct one call. */
function parseRemoteCreate(args: Record<string, unknown>, serverId: string) {
  const known = new Set(Object.keys(remoteCreate.shape));
  const unsupported = Object.keys(args).filter((key) => args[key] !== undefined && !known.has(key));
  const missing = (["workspaceId", "provider"] as const).filter((key) => !args[key]);
  if (unsupported.length > 0 || missing.length > 0) {
    const details = [
      missing.length > 0 ? `Missing: ${missing.join(", ")}.` : "",
      unsupported.length > 0 ? `Not accepted: ${unsupported.join(", ")}.` : "",
      missing.includes("provider")
        ? `Call list_providers with serverId ${serverId} and pass provider as <provider>/<model>.`
        : "",
      missing.includes("workspaceId")
        ? `Get workspaceId from list_workspaces or create_workspace with serverId ${serverId}.`
        : "",
    ].filter(Boolean);
    throw new PimiToolInputError(`${REMOTE_CREATE_REQUIRES} ${details.join(" ")}`);
  }
  const parsed = remoteCreate.safeParse(args);
  if (!parsed.success) throw new PimiToolInputError(parsed.error.message, parsed.error.issues);
  return parsed.data;
}
function remoteProviderModel(provider: string, serverId: string) {
  try {
    return resolveRequiredProviderModel(provider);
  } catch {
    throw new PimiToolInputError(
      `On another host provider must be <provider>/<model>. Call list_providers and list_models with serverId ${serverId}.`,
    );
  }
}
const result = (structuredContent: unknown): PimiToolResult => ({
  content: [],
  structuredContent,
});

export function createHostResolver(input: {
  serverId: string;
  local: HostOperations;
  hosts: () => ToolHosts;
  callerAgentId?: string;
  /** The destination can't see the caller, so its background defaults resolve before routing. */
  caller: () => BackgroundCaller | null;
  lockedCwd?: string;
}) {
  return {
    directory: () => input.hosts().directory(),
    async use<T>(
      serverId: string | undefined,
      action: (host: HostOperations) => Promise<T>,
    ): Promise<T> {
      const destination = serverId ?? input.serverId;
      if (destination === input.serverId) return action(input.local);
      if (input.lockedCwd)
        throw new Error("This caller is restricted to its local working directory");
      return input.hosts().use(destination, async (client) =>
        action({
          async createAgent(args) {
            const parsed = parseRemoteCreate(args, destination);
            const { provider, model } = remoteProviderModel(parsed.provider, destination);
            const workspace = await client.findWorkspace(parsed.workspaceId);
            if (!workspace) throw new Error(`Workspace ${parsed.workspaceId} not found`);
            const labels = {
              ...parsed.labels,
              ...(input.callerAgentId
                ? parentAddressLabels({ agentId: input.callerAgentId, serverId: input.serverId })
                : {}),
            };
            let createdSnapshot: Awaited<ReturnType<DaemonClient["createAgent"]>>;
            try {
              createdSnapshot = await client.createAgent({
                config: {
                  provider,
                  model,
                  cwd: workspace.workspaceDirectory,
                  title: parsed.title,
                  modeId: parsed.settings?.modeId,
                  thinkingOptionId: parsed.settings?.thinkingOptionId,
                  featureValues: parsed.settings?.features,
                },
                workspaceId: parsed.workspaceId,
                // Older hosts reject any background with a workspaceId, so a visible create omits it.
                ...(inheritAgentBackground(parsed.background, input.caller())
                  ? { background: true }
                  : {}),
                labels,
                initialPrompt: parsed.initialPrompt,
                idempotencyKey: parsed.idempotencyKey,
              });
            } catch (error) {
              throw withProviderHint(error, destination);
            }
            const snapshot = createdSnapshot;
            const payload = {
              agentId: snapshot.id,
              type: snapshot.provider,
              status: snapshot.status,
              cwd: snapshot.cwd,
              workspaceId: snapshot.workspaceId,
              currentModeId: snapshot.currentModeId,
              availableModes: snapshot.availableModes,
            };
            if (!input.callerAgentId) return result(payload);
            // Same receipt the local path returns, so the chat shows a card for the remote child.
            const structuredContent = {
              ...payload,
              pimiDelegation: {
                source: { serverId: input.serverId, agentId: input.callerAgentId },
                worker: {
                  id: snapshot.id,
                  serverId: destination,
                  provider: snapshot.provider,
                  model: snapshot.model ?? null,
                  title: parsed.title,
                },
                sharedContext: false,
              },
            };
            return {
              content: [{ type: "text", text: JSON.stringify(structuredContent) }],
              structuredContent,
            };
          },
          async sendPrompt(args) {
            const agentId = args.agentId as string;
            // Human sends set the mode through the mode RPC.
            // Agent sends apply their requested mode when the recipient dispatches the batch.
            if (!input.callerAgentId && args.sessionMode !== undefined) {
              await client.setAgentMode(agentId, args.sessionMode as string);
            }
            const agent = (
              await client.fetchAgent({ agentId }).catch((error) => {
                // Snapshot preflight precedes sendMessage, so failure is definitely unsent.
                throw new HostOperationRejectedError(error);
              })
            )?.agent;
            if (!agent)
              throw new HostOperationRejectedError(new Error(`Agent ${agentId} not found`));
            const receipt = await client
              .sendMessage(agentId, args.prompt as string, {
                sessionMode: input.callerAgentId
                  ? (args.sessionMode as string | undefined)
                  : undefined,
                sourceAgentId: input.callerAgentId,
                sourceAgentServerId: input.callerAgentId ? input.serverId : undefined,
                activeTurnBehavior:
                  (args.activeTurnBehavior as ActiveTurnBehavior | undefined) ??
                  (input.callerAgentId ? "steer" : "interrupt"),
              })
              .catch((error) => {
                if (isAmbiguousPromptFailure(error)) throw error;
                throw new HostOperationRejectedError(error);
              });
            return result({
              success: true,
              ...receipt,
              status: agent.status,
              guidance:
                receipt.deliveryStatus === "queued"
                  ? "Queued for delivery after two quiet seconds. You will get notified when the prompted agent finishes, errors, or needs permission unless notifyOnFinish is false."
                  : "Dispatch acknowledged. Observe completion using get_agent_status/get_agent_activity or SDK/RPC subscriptions and wait APIs.",
            });
          },
          async getStatus(args) {
            const agent = (await client.fetchAgent({ agentId: args.agentId as string }))?.agent;
            if (!agent) throw new Error(`Agent ${args.agentId} not found`);
            return result({ status: agent.status, snapshot: agent });
          },
          async getActivity(args) {
            const agentId = args.agentId as string;
            const limit = args.limit as number | undefined;
            const timeline = await client.fetchAgentTimeline(agentId, {
              direction: "tail",
              limit: limit ?? 0,
            });
            const agent = (await client.fetchAgent({ agentId }))?.agent;
            if (!agent) throw new Error(`Agent ${agentId} not found`);
            return result({
              agentId,
              ...summarizeAgentActivity(
                timeline.entries.map((entry) => entry.item),
                limit,
              ),
              currentModeId: agent.currentModeId,
            });
          },
          async listAgents(args) {
            const { entries } = await client.fetchAgents({
              includeBackground: args.includeBackground === true,
              filter: { includeArchived: args.includeArchived === true },
            });
            return result({
              agents: selectAgentListItems(
                entries.map((entry) => entry.agent),
                {
                  cwd: (args.cwd as string | undefined)?.trim()
                    ? expandUserPath(args.cwd as string)
                    : undefined,
                  statuses: args.statuses as AgentSnapshotPayload["status"][] | undefined,
                  sinceHours: args.sinceHours as number | undefined,
                  limit: args.limit as number | undefined,
                },
              ),
            });
          },
          async listWorkspaces(args) {
            const { entries } = await client.fetchWorkspaces({
              includeBackground: args.includeBackground === true,
            });
            return result({ workspaces: entries.map(workspaceSummary) });
          },
          async listProviders() {
            const { entries } = await client.getProvidersSnapshot();
            return result({ providers: entries.map(toProviderSummary) });
          },
          async listModels(args) {
            const provider = args.provider as string;
            const payload = await client.listProviderModels(provider);
            if (payload.error) throw new Error(payload.error);
            return result(limitModelList(provider, payload.models ?? [], args.query as string));
          },
          async cancelAgent(args) {
            await client.cancelAgent(args.agentId as string);
            return result({ success: true });
          },
          async archiveAgent(args) {
            await client.archiveAgent(args.agentId as string);
            return result({ success: true });
          },
          async createWorkspace(args) {
            const isolation = z.enum(["local", "worktree"]).parse(args.isolation);
            const path = z.string().min(1).parse(args.path);
            const response = await client.createWorkspace({
              source:
                isolation === "local"
                  ? { kind: "directory", path, projectId: args.projectId as string | undefined }
                  : {
                      kind: "worktree",
                      cwd: path,
                      projectId: args.projectId as string | undefined,
                      action:
                        args.mode === "checkout-branch" || args.mode === "checkout-pr"
                          ? "checkout"
                          : "branch-off",
                      baseBranch: args.baseBranch as string | undefined,
                      branchName: args.branchName as string | undefined,
                      refName: args.branch as string | undefined,
                      checkoutSource:
                        args.prNumber === undefined
                          ? undefined
                          : { kind: "change_request", number: args.prNumber as number },
                      worktreeSlug: args.worktreeSlug as string | undefined,
                    },
              title: args.title as string | undefined,
              background: inheritWorkspaceBackground(
                args.background as boolean | undefined,
                input.caller(),
              ),
            });
            if (response.error || !response.workspace)
              throw new Error(response.error ?? "Workspace creation failed");
            return result(workspaceSummary(response.workspace));
          },
        }),
      );
    },
  };
}
/** The destination's own error says what failed; this only adds where to look next. */
function withProviderHint(error: unknown, serverId: string): unknown {
  if (!(error instanceof Error) || !/provider|model/i.test(error.message)) return error;
  return Object.assign(
    new Error(`${error.message} Call list_providers with serverId ${serverId}.`, { cause: error }),
    "code" in error ? { code: error.code } : {},
  );
}
function workspaceSummary(workspace: FetchWorkspacesEntry) {
  return {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    cwd: workspace.workspaceDirectory,
    isolation: workspace.workspaceKind === "worktree" ? "worktree" : "local",
    kind: workspace.workspaceKind,
    title: workspace.title,
    background: workspace.background,
  };
}

function remoteObservation(client: DaemonClient): HostObservation {
  return {
    async observe(agentId, handler, signal, onError) {
      const observation = client.observeTimeline([agentId], { signal });
      const refresh = async (event?: AgentStreamEvent) => {
        let snapshot = (await client.fetchAgent({ agentId }))?.agent ?? null;
        let lastMessage: string | null = null;
        if (
          snapshot &&
          (snapshot.status === "idle" ||
            snapshot.status === "closed" ||
            snapshot.status === "error" ||
            snapshot.pendingPermissions.length > 0)
        ) {
          // A new turn may start between the snapshot and the current-response read.
          // Bound that wait and refresh state instead of attributing the old event to it.
          const current = await client.waitForFinish(agentId, 100);
          if (current.status === "timeout") {
            // Queued delivery can leave a closed/error snapshot visible before the new turn.
            // A timed-out wait has not established an outcome for that queued work.
            if (event?.type === "permission_resolved") handler(snapshot, event);
            return;
          }
          if (!current.final && current.error && current.error !== `Agent not found: ${agentId}`)
            throw new Error(current.error);
          snapshot = current.final;
          lastMessage = current.lastMessage;
        }
        handler(snapshot, event, lastMessage);
      };
      let updates = Promise.resolve();
      const unsubscribe = observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "agent_stream" || message.payload.agentId !== agentId) return;
          const event = message.payload.event;
          if (
            event.type === "permission_requested" ||
            event.type === "permission_resolved" ||
            event.type === "turn_started" ||
            event.type === "turn_completed" ||
            event.type === "turn_canceled" ||
            event.type === "turn_failed"
          )
            updates = updates.then(() => refresh(event)).catch(onError);
        },
        error: onError,
      });
      try {
        await observation.ready;
        await refresh();
      } catch (error) {
        unsubscribe();
        await observation.release();
        throw error;
      }
      return async () => {
        unsubscribe();
        await observation.release();
      };
    },
    wait: (agentId, signal) => {
      const close = () => void client.close();
      signal.addEventListener("abort", close, { once: true });
      return client
        .waitForFinish(agentId, 0)
        .then((outcome) => {
          if (!outcome.final && outcome.error && outcome.error !== `Agent not found: ${agentId}`)
            throw new Error(outcome.error);
          return outcome;
        })
        .finally(() => signal.removeEventListener("abort", close));
    },
  };
}

/** Shares routed status observation with daemon services independently of MCP execution. */
export function createHostObservationResolver(input: {
  serverId: string;
  local: HostObservation;
  hosts(): ToolHosts;
}) {
  return {
    async use<T>(
      serverId: string | undefined,
      action: (host: HostObservation) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      if (!serverId || serverId === input.serverId) return action(input.local);
      const hosts = input.hosts();
      async function classify(error: unknown): Promise<HostObservationError> {
        // This is the origin's authoritative registration directory, not a destination RPC error.
        const row = (await hosts.directory()).hosts.find((host) => host.serverId === serverId);
        if (!row) return new HostObservationError("removed", error);
        if (row.status === "connecting") return new HostObservationError("connecting", error);
        return new HostObservationError("unreachable", error);
      }
      async function fail(error: unknown): Promise<never> {
        throw await classify(error);
      }
      try {
        return await hosts.use(
          serverId,
          (client) => {
            const remote = remoteObservation(client);
            return action({
              wait: (agentId, lifetime) => remote.wait(agentId, lifetime).catch(fail),
              observe(agentId, handler, lifetime, onError) {
                async function report(error: unknown): Promise<void> {
                  try {
                    onError(await classify(error));
                  } catch (failure) {
                    onError(failure);
                  }
                }
                return remote.observe(agentId, handler, lifetime, report).catch(fail);
              },
            });
          },
          signal,
        );
      } catch (error) {
        if (error instanceof HostObservationError) throw error;
        return fail(error);
      }
    },
  };
}
