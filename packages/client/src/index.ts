export type { TerminalReplayEvent, TerminalStreamEvent } from "./terminal-stream-router.js";
import type { AgentAddress } from "@pimi/protocol/addresses";
import { parentAddressLabels } from "@pimi/protocol/agent-labels";
export type { AgentAddress } from "@pimi/protocol/addresses";
import { createHostActions, type PimiHostActions } from "./hosts/index.js";
export type { PimiHostActions } from "./hosts/index.js";
export type { HostAdd, HostUpdate, HostSummary, HostDirectory } from "@pimi/protocol/hosts";
import type { OwnedSubscription } from "./connection/index.js";
export type { OwnedSubscription, SubscriptionObserver } from "./connection/index.js";
import type { AgentPermissionResponse } from "@pimi/protocol/agent-types";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  CreateAgentRequestMessage,
  FetchWorkspacesRequestMessage,
  FetchWorkspacesResponseMessage,
  GetProvidersSnapshotResponseMessage,
  ListAvailableProvidersResponse,
  ListCommandsResponse,
  ListProviderFeaturesRequestMessage,
  ListProviderFeaturesResponseMessage,
  ListProviderModelsResponseMessage,
  ProjectListRequestMessage,
  ProjectListResponseMessage,
  ListProviderModesResponseMessage,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
  ProviderDiagnosticResponseMessage,
  ProjectPlacementPayload,
  WorkspaceProjectDescriptorPayload,
  RefreshProvidersSnapshotResponseMessage,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
  WorkspaceCreateRequest,
} from "@pimi/protocol/messages";
import { DaemonClient, type CreateAgentRequestOptions } from "./daemon-client.js";
import {
  createTerminalActions,
  type PimiTerminalActions,
  type PimiWorkspaceTerminalActions,
} from "./terminals/index.js";
export type {
  PimiTerminal,
  PimiTerminalActions,
  PimiTerminalHandle,
  PimiTerminalCreateOptions,
  PimiTerminalListOptions,
  PimiTerminalListResult,
  PimiTerminalCaptureOptions,
  PimiTerminalCaptureResult,
  PimiWorkspaceTerminalActions,
} from "./terminals/index.js";
import type { PluginTimelineItem } from "@pimi/protocol/agent-types";
import type {
  AgentBackgroundWorkItem,
  AgentForkContextOptions,
  AgentForkContextPayload,
  FetchAgentsEntry,
  FetchAgentsOptions,
  FetchAgentsPageInfo,
  FetchAgentTimelineCursor,
  FetchAgentTimelineDirection,
  FetchAgentTimelinePayload,
  SendMessageOptions,
  WaitForFinishResult,
} from "./daemon-client.js";

/**
 * Coding turns routinely run for minutes, so the handle waits far longer than
 * the transport's own conservative default.
 */
const DEFAULT_WAIT_FOR_FINISH_MS = 10 * 60_000;

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "disconnected"; reason?: string }
  | { status: "disposed" };

export interface PimiLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface PimiClientConfig {
  url: string;
  clientId?: string;
  appVersion?: string;
  runtimeGeneration?: number | null;
  password?: string;
  authHeader?: string;
  suppressSendErrors?: boolean;
  logger?: PimiLogger;
  connectTimeoutMs?: number;
  e2ee?: {
    enabled?: boolean;
    daemonPublicKeyB64?: string;
  };
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  runtimeMetricsIntervalMs?: number;
  runtimeMetricsWindowMs?: number;
}

export type PimiWorkspace = WorkspaceDescriptorPayload;
export type PimiAgent = AgentSnapshotPayload;
export type PimiAgentListOptions = FetchAgentsOptions;
export type PimiProject = WorkspaceProjectDescriptorPayload;
export type PimiProjectListOptions = Omit<ProjectListRequestMessage, "type" | "requestId"> & {
  requestId?: string;
};
export type PimiProjectListResult = ProjectListResponseMessage["payload"];
export type PimiProjectUpdate = Extract<
  SessionOutboundMessage,
  { type: "project.update" }
>["payload"];
export type PimiProjectUpdateHandler = (update: PimiProjectUpdate) => void;

export interface PimiAgentListResult {
  subscription?: OwnedSubscription<PimiAgentListResult>;
  requestId: string;
  subscriptionId?: string | null;
  entries: FetchAgentsEntry[];
  pageInfo: FetchAgentsPageInfo;
}
export type PimiWorkspaceListOptions = Omit<FetchWorkspacesRequestMessage, "type" | "requestId"> & {
  requestId?: string;
};

export interface PimiWorkspaceListResult {
  subscription?: OwnedSubscription<PimiWorkspaceListResult>;
  requestId: string;
  subscriptionId?: string | null;
  entries: PimiWorkspace[];
  pageInfo: FetchWorkspacesResponseMessage["payload"]["pageInfo"];
}

export interface PimiWorkspaceOpenOptions {
  cwd: string;
  requestId?: string;
}

export type PimiWorkspaceCreateOptions = Omit<
  WorkspaceCreateRequest,
  "type" | "requestId" | "agent" | "subscribe"
> & {
  requestId?: string;
  agent?: Omit<
    PimiAgentCreateOptions,
    "worktree" | "git" | "onEvent" | "idempotencyKey" | "requestId"
  >;
  onEvent?: (snapshot: CreationSnapshot) => void;
};

export interface PimiWorkspaceArchiveResult {
  requestId: string;
  workspaceId: string;
  archivedAt: string | null;
  error: string | null;
}

export type PimiWorkspaceUpdate = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];

export type PimiWorkspaceUpdateHandler = (update: PimiWorkspaceUpdate) => void;

export interface PimiWorkspaceHandle {
  readonly id: string;
  readonly projectId: string | null;
  readonly directory: string | null;
  readonly name: string | null;
  readonly status: PimiWorkspace["status"] | null;
  readonly agents: {
    create(options: PimiWorkspaceAgentCreateOptions): Promise<PimiAgentHandle>;
  };
  readonly terminals: PimiWorkspaceTerminalActions;
  current(): PimiWorkspace | null;
  refresh(options?: { requestId?: string }): Promise<PimiWorkspace | null>;
  setTitle(title: string | null, requestId?: string): Promise<{ title: string | null }>;
  setBaseBranch(options: {
    baseRef: string;
    requestId?: string;
  }): Promise<{ baseRef: string | null }>;
  archive(requestId?: string): Promise<PimiWorkspaceArchiveResult>;
  /**
   * Subscribes to already-emitted daemon workspace_update events for this id.
   * This returns a local unsubscribe function; it does not own app cache state or
   * send a daemon unsubscribe RPC. Call `workspaces.list({ subscribe: {} })` when
   * the daemon should start streaming workspace directory updates.
   */
  subscribe(handler: (update: PimiWorkspaceUpdate) => void): () => void;
}

export interface PimiProjectActions {
  list(options?: PimiProjectListOptions): Promise<PimiProjectListResult>;
  subscribe(handler: PimiProjectUpdateHandler): () => void;
}

export interface PimiWorkspaceActions {
  list(options: PimiWorkspaceListOptions & { subscribe: {} }): Promise<
    PimiWorkspaceListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<PimiWorkspaceListResult>;
    }
  >;
  list(options?: PimiWorkspaceListOptions): Promise<PimiWorkspaceListResult>;
  ref(workspace: string | PimiWorkspace): PimiWorkspaceHandle;
  open(input: string | PimiWorkspaceOpenOptions, requestId?: string): Promise<PimiWorkspaceHandle>;
  create(options: PimiWorkspaceCreateOptions): Promise<PimiWorkspaceHandle>;
  archive(
    workspace: string | PimiWorkspaceHandle,
    requestId?: string,
  ): Promise<PimiWorkspaceArchiveResult>;
  /**
   * Local event subscription over the low-level driver's workspace_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: PimiWorkspaceUpdateHandler): () => void;
}

type PimiAgentSessionConfig = CreateAgentRequestMessage["config"];
export type PimiAgentProvider = PimiAgentSessionConfig["provider"];

export type PimiProviderFeatureValues = Record<string, unknown>;

export interface PimiAgentConfig {
  /** Provider and model in `provider/model` format. */
  provider: string;
  modeId?: PimiAgentSessionConfig["modeId"];
  thinkingOptionId?: PimiAgentSessionConfig["thinkingOptionId"];
  featureValues?: PimiProviderFeatureValues;
  /** JSON-safe provider-native settings, validated by the selected provider. */
  options?: PimiAgentSessionConfig["providerOptions"];
  systemPrompt?: PimiAgentSessionConfig["systemPrompt"];
  toolPolicy?: PimiAgentSessionConfig["toolPolicy"];
  mcpServers?: PimiAgentSessionConfig["mcpServers"];
}

export interface PimiAgentCreateOptions {
  idempotencyKey?: string;
  agentId?: string;
  onEvent?: (snapshot: CreationSnapshot) => void;
  config: PimiAgentConfig;
  cwd: string;
  parent?: string | AgentAddress | PimiAgentHandle;
  /** Deliver the initial turn's result to a parent on the same host. */
  notifyOnFinish?: boolean;
  title?: PimiAgentSessionConfig["title"];
  env?: CreateAgentRequestMessage["env"];
  prompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: CreateAgentRequestMessage["images"];
  attachments?: CreateAgentRequestMessage["attachments"];
  git?: CreateAgentRequestMessage["git"];
  worktree?: CreateAgentRequestMessage["worktree"];
  autoArchive?: CreateAgentRequestMessage["autoArchive"];
  /**
   * Creates a background agent: hidden from default lists, tabs, the parent's subagent track
   * and notifications, and still addressable by id. A workspace this call creates is
   * background too. With a parent and no value, the parent's own background applies.
   */
  background?: CreateAgentRequestMessage["background"];
  requestId?: string;
  labels?: Record<string, string>;
}

export type PimiWorkspaceAgentCreateOptions = Omit<PimiAgentCreateOptions, "cwd">;

export interface PimiAgentRefetchResult {
  agent: PimiAgent;
  project: ProjectPlacementPayload | null;
}

export interface PimiAgentTimelineRefetchOptions {
  direction?: FetchAgentTimelineDirection;
  cursor?: FetchAgentTimelineCursor;
  limit?: number;
  requestId?: string;
}

export type PimiAgentSendOptions = SendMessageOptions;

export interface PimiAgentRunOptions extends PimiAgentSendOptions {
  timeoutMs?: number;
}

export type PimiAgentRunResult = WaitForFinishResult;
export type PimiAgentPermissionResponse = AgentPermissionResponse;

export interface PimiAgentRespondToPermissionOptions {
  requestId: string;
  response: PimiAgentPermissionResponse;
}

export interface PimiAgentCommandsOptions {
  requestId?: string;
}

export type PimiAgentCommandsResult = ListCommandsResponse["payload"];

export type PimiAgentUpdate = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];

export type PimiAgentStream = Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"];

export type PimiAgentUpdateHandler = (update: PimiAgentUpdate) => void;

export type PimiAgentTimelineEvent =
  | PimiAgentStream
  | {
      agentId: string;
      event: { type: "replacement"; epoch: string };
    }
  | {
      agentId: string;
      subscriptionId: string;
      event: { type: "subscription_restored" };
    }
  | { agentId: string; event: { type: "error"; error: string } };

export type PimiAgentTimelineSubscription = ReturnType<DaemonClient["subscribeAgentTimeline"]>;

export interface PimiAgentTimelineHandle {
  append(item: Omit<PluginTimelineItem, "pluginId">): Promise<{ seq: number; epoch: string }>;
  /**
   * Fetches a fresh timeline page through the existing daemon RPC. If the daemon
   * includes an agent snapshot in the response, the parent handle is updated to
   * that value.
   */
  refetch(options?: PimiAgentTimelineRefetchOptions): Promise<FetchAgentTimelinePayload>;
  /**
   * Delivers live events only. After reconnect, subscription_restored precedes
   * subsequent updates. History may have been missed; use refetch() to request
   * the range you need. No history is fetched automatically. A replacement event
   * invalidates the previous epoch. Subscription errors release this observation.
   * Await the returned unsubscribe function's `ready` promise before starting
   * work that must be observed. It rejects if establishment fails.
   */
  subscribe(handler: (event: PimiAgentTimelineEvent) => void): PimiAgentTimelineSubscription;
}

export type PimiAgentBackgroundWorkItem = AgentBackgroundWorkItem;

export interface PimiAgentBackgroundWorkHandle {
  /** Stop one item and wait for provider confirmation. */
  stop(
    item: PimiAgentBackgroundWorkItem,
    options?: { requestId?: string; timeout?: number },
  ): Promise<void>;
  /** Reads the agent's current background work once. */
  list(options?: { requestId?: string; timeout?: number }): Promise<PimiAgentBackgroundWorkItem[]>;
  /**
   * Calls `listener` with the agent's current list once the subscription is established, again
   * after each reconnect, then with the full list each time it changes. Returns the unsubscribe
   * function.
   *
   * When reading the current list fails, `options.onError` receives the error and `listener` is
   * not called; without `onError` the error is logged. The read is not retried: the next
   * reconnect reads the list again.
   */
  subscribe(
    listener: (items: PimiAgentBackgroundWorkItem[]) => void,
    options?: PimiAgentBackgroundWorkSubscribeOptions,
  ): () => void;
}

export interface PimiAgentBackgroundWorkSubscribeOptions {
  /** Receives the error when reading the agent's current list fails. */
  onError?: (error: unknown) => void;
}

export interface PimiAgentHandle {
  readonly id: string;
  readonly address: AgentAddress;
  /**
   * `workspaceId` through `archivedAt` mirror the last snapshot this handle
   * observed. A handle from `ref()` reads `null` for all of them until
   * `refresh()`, `run()`, `waitForFinish()`, a timeline refetch, or
   * `subscribe()` delivers a snapshot. Optional snapshot values also read as
   * `null`; use `current()` when you need to distinguish those states.
   */
  readonly workspaceId: string | null;
  readonly cwd: string | null;
  readonly status: PimiAgent["status"] | null;
  readonly capabilities: PimiAgent["capabilities"] | null;
  readonly availableModes: PimiAgent["availableModes"] | null;
  readonly pendingPermissions: PimiAgent["pendingPermissions"] | null;
  readonly activeTurn: NonNullable<PimiAgent["activeTurn"]> | null;
  readonly lastUsage: NonNullable<PimiAgent["lastUsage"]> | null;
  readonly lastError: NonNullable<PimiAgent["lastError"]> | null;
  readonly features: NonNullable<PimiAgent["features"]> | null;
  readonly runtimeInfo: NonNullable<PimiAgent["runtimeInfo"]> | null;
  readonly archivedAt: NonNullable<PimiAgent["archivedAt"]> | null;
  readonly timeline: PimiAgentTimelineHandle;
  readonly backgroundWork: PimiAgentBackgroundWorkHandle;
  /** Capture portable chat context for a continuation or delegated task. */
  buildForkContext(options?: AgentForkContextOptions): Promise<AgentForkContextPayload>;
  current(): PimiAgent | null;
  refresh(requestId?: string): Promise<PimiAgentRefetchResult | null>;
  /**
   * Reopens the provider session with current configuration, rerunning session-open hooks.
   * Interrupts a running turn and returns the refreshed snapshot.
   */
  reload(options?: { requestId?: string }): Promise<PimiAgentRefetchResult | null>;
  send(text: string, options?: PimiAgentSendOptions): Promise<void>;
  respondToPermission(options: PimiAgentRespondToPermissionOptions): Promise<void>;
  /** Sends a prompt and resolves when that turn finishes or needs attention. */
  run(text: string, options?: PimiAgentRunOptions): Promise<PimiAgentRunResult>;
  /** Waits for the current turn, including one started with `prompt`. */
  waitForFinish(timeoutMs?: number): Promise<PimiAgentRunResult>;
  /**
   * Asks the running session for the slash commands and skills it actually
   * loaded. Providers answer from the live session, so this sees built-in and
   * bundled entries that no directory scan can find. The payload carries its own
   * `error` string; a provider that cannot answer reports it there rather than
   * rejecting.
   */
  commands(options?: PimiAgentCommandsOptions): Promise<PimiAgentCommandsResult>;
  archive(): Promise<{ archivedAt: string }>;
  detach(): Promise<void>;
  subscribe(handler: (update: PimiAgentUpdate) => void): () => void;
}

export interface PimiAgentActions {
  list(options: PimiAgentListOptions & { subscribe: {} }): Promise<
    PimiAgentListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<PimiAgentListResult>;
    }
  >;
  list(options?: PimiAgentListOptions): Promise<PimiAgentListResult>;
  ref(agent: string | PimiAgent): PimiAgentHandle;
  create(options: PimiAgentCreateOptions): Promise<PimiAgentHandle>;
  /**
   * Local event subscription over the low-level driver's agent_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: PimiAgentUpdateHandler): () => void;
}

export type PimiProviderModelsResult = ListProviderModelsResponseMessage["payload"];
export type PimiProviderModesResult = ListProviderModesResponseMessage["payload"];
type PimiProviderFeaturesDraft = ListProviderFeaturesRequestMessage["draftConfig"];
export interface PimiProviderFeaturesInput extends Omit<
  PimiProviderFeaturesDraft,
  "provider" | "model"
> {
  /** Provider and model in `provider/model` format. */
  provider: string;
}
export type PimiProviderFeaturesResult = ListProviderFeaturesResponseMessage["payload"];
export type PimiProviderAvailabilityResult = ListAvailableProvidersResponse["payload"];
export type PimiProviderSnapshotResult = GetProvidersSnapshotResponseMessage["payload"];
export type PimiProviderSnapshotUpdate = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>["payload"];
export type PimiProviderRefreshResult = RefreshProvidersSnapshotResponseMessage["payload"];
export type PimiProviderDiagnosticResult = ProviderDiagnosticResponseMessage["payload"];

export interface PimiProviderListOptions {
  cwd?: string;
  requestId?: string;
}

export interface PimiProviderRefreshOptions {
  cwd?: string;
  providers?: PimiAgentProvider[];
  requestId?: string;
}

export interface PimiProviderWaitOptions extends PimiProviderListOptions {
  timeoutMs?: number;
}

export interface PimiProviderActions {
  listModels(
    provider: PimiAgentProvider,
    options?: PimiProviderListOptions,
  ): Promise<PimiProviderModelsResult>;
  listModes(
    provider: PimiAgentProvider,
    options?: PimiProviderListOptions,
  ): Promise<PimiProviderModesResult>;
  listFeatures(
    draftConfig: PimiProviderFeaturesInput,
    options?: { requestId?: string },
  ): Promise<PimiProviderFeaturesResult>;
  listAvailable(options?: { requestId?: string }): Promise<PimiProviderAvailabilityResult>;
  snapshot(options?: PimiProviderListOptions): Promise<PimiProviderSnapshotResult>;
  /** Resolves after the daemon's lazy provider discovery has finished. */
  waitForReady(options?: PimiProviderWaitOptions): Promise<PimiProviderSnapshotResult>;
  refresh(options?: PimiProviderRefreshOptions): Promise<PimiProviderRefreshResult>;
  diagnostic(
    provider: PimiAgentProvider,
    options?: { requestId?: string },
  ): Promise<PimiProviderDiagnosticResult>;
  subscribe(handler: (update: PimiProviderSnapshotUpdate) => void): () => void;
}

export interface PimiConfigActions {
  /**
   * Reads daemon config through the existing config RPC. Provider profiles,
   * custom provider entries, keys/env, custom binaries, and provider enablement
   * are currently config-file-shaped daemon state, so the SDK exposes this raw
   * typed surface instead of pretending there are higher-level provider-settings
   * RPCs.
   */
  get(requestId?: string): Promise<{ requestId: string; config: MutableDaemonConfig }>;
  /**
   * Patches daemon config through the existing config RPC. The daemon validates
   * and persists supported fields; unsupported provider/settings workflows remain
   * daemon gaps until first-class RPCs exist.
   */
  patch(
    config: MutableDaemonConfigPatch,
    requestId?: string,
  ): Promise<{ requestId: string; config: MutableDaemonConfig }>;
}

/** A workspace's files, by absolute `cwd` (the workspace directory) and a path relative to it. */
export interface PimiFileActions {
  list(cwd: string, path: string, requestId?: string): ReturnType<DaemonClient["listDirectory"]>;
  read(
    cwd: string,
    path: string,
    options?: { requestId?: string; maxBytes?: number; timeout?: number },
  ): ReturnType<DaemonClient["readFile"]>;
  write: DaemonClient["writeFile"];
  /** Emits the current version, then every change. Release it when done. */
  observe: DaemonClient["observeFile"];
  create: DaemonClient["createFileEntry"];
  rename: DaemonClient["renameFileEntry"];
  duplicate: DaemonClient["duplicateFileEntry"];
  remove: DaemonClient["deleteFileEntry"];
}

/** Git state of a checkout, by absolute `cwd`. */
export interface PimiGitActions {
  status(
    cwd: string,
    options?: { requestId?: string },
  ): ReturnType<DaemonClient["getCheckoutStatus"]>;
  diff: DaemonClient["getCheckoutDiff"];
  /** Emits the diff, then every change. Release it when done. */
  observeDiff: DaemonClient["observeCheckoutDiff"];
  commits: DaemonClient["listCheckoutCommits"];
  blame: DaemonClient["getLineBlame"];
  commitFileDiff: DaemonClient["getCommitFileDiff"];
}

export interface PimiSearchActions {
  /**
   * Streams matches to `onFiles` and resolves with the stats when the search ends. Pass `requestId`
   * to cancel a running search with `cancel`.
   */
  workspace: DaemonClient["searchWorkspace"];
  cancel(requestId: string): Promise<boolean>;
}

export interface PimiApi {
  readonly hosts: PimiHostActions;
  readonly files: PimiFileActions;
  readonly git: PimiGitActions;
  readonly search: PimiSearchActions;
  dispose(): Promise<void>;
  observeEvents: DaemonClient["observeEvents"];
  readonly terminals: PimiTerminalActions;
  readonly workspaces: PimiWorkspaceActions;
  readonly workspaceLabels: {
    list: DaemonClient["listWorkspaceLabels"];
    observe: DaemonClient["observeWorkspaceLabels"];
    set: DaemonClient["setWorkspaceLabel"];
  };
  readonly projects: PimiProjectActions;
  readonly agents: PimiAgentActions;
  readonly providers: PimiProviderActions;
  readonly config: PimiConfigActions;
}

export interface PimiClient extends PimiApi {
  connect(): Promise<void>;
  close(): Promise<void>;
  ensureConnected(): void;
  getConnectionState(): ConnectionState;
}

export function createPimiClient(config: PimiClientConfig): PimiClient {
  const daemonClient = new DaemonClient({
    ...config,
    clientId: config.clientId ?? createGeneratedClientId(),
    clientType: "cli",
  });
  const api = createPimiApi(daemonClient);
  return {
    ...api,
    connect: () => daemonClient.connect(),
    close: async () => {
      try {
        await api.dispose();
      } finally {
        await daemonClient.close();
      }
    },
    ensureConnected: () => daemonClient.ensureConnected(),
    getConnectionState: () => daemonClient.getConnectionState(),
  };
}

function toDaemonAgentCreateOptions(
  options: PimiAgentCreateOptions,
  placement?: { workspaceId: string; cwd: string },
  serverInfo?: ReturnType<DaemonClient["getLastServerInfoMessage"]>,
): CreateAgentRequestOptions {
  const { config: agentConfig, cwd, parent, title, prompt, ...requestOptions } = options;
  const { provider: providerModel, options: providerOptions, ...runtimeConfig } = agentConfig;
  const { provider, model } = parseProviderModel(providerModel);
  const relationship = parent ? encodeParent(parent, serverInfo?.serverId) : {};
  if (requestOptions.notifyOnFinish) {
    if (!relationship.callerAgentId)
      throw new Error("Finish notifications require a parent on this host.");
  }
  return {
    ...requestOptions,
    config: {
      ...runtimeConfig,
      provider,
      model,
      cwd: placement?.cwd ?? cwd,
      ...(title !== undefined ? { title } : {}),
      ...(providerOptions !== undefined ? { providerOptions } : {}),
    },
    ...(placement ? { workspaceId: placement.workspaceId } : {}),
    ...(parent
      ? {
          ...relationship,
          labels: { ...requestOptions.labels, ...relationship.labels },
        }
      : {}),
    ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
  };
}

export function createPimiApi(
  daemonClient: DaemonClient,
  scopeOptions?: { signal?: AbortSignal },
): PimiApi {
  const handles = new Set<{ release(): Promise<void> }>();
  const agentListeners = new Set<PimiAgentUpdateHandler>();
  const workspaceListeners = new Set<PimiWorkspaceUpdateHandler>();
  const lifetime = new AbortController();
  const own = <T extends { release(): Promise<void> }>(create: () => T): T => {
    if (lifetime.signal.aborted) throw new Error("Pimi API is disposed");
    const handle = create();
    handles.add(handle);
    const release = handle.release.bind(handle);
    handle.release = async () => {
      await release();
      handles.delete(handle);
    };
    return handle;
  };
  const listenAgents = (handler: PimiAgentUpdateHandler) => {
    if (lifetime.signal.aborted) throw new Error("Pimi API is disposed");
    agentListeners.add(handler);
    return () => {
      agentListeners.delete(handler);
    };
  };
  const listenWorkspaces = (handler: PimiWorkspaceUpdateHandler) => {
    if (lifetime.signal.aborted) throw new Error("Pimi API is disposed");
    workspaceListeners.add(handler);
    return () => {
      workspaceListeners.delete(handler);
    };
  };
  const createAgentHandle = createAgentHandleFactory(
    daemonClient,
    listenAgents,
    (agentId, handler) => own(() => daemonClient.subscribeAgentTimeline(agentId, handler)),
    () => own(() => daemonClient.observeAgentBackgroundWork()),
  );
  const createAgent = async (
    options: PimiAgentCreateOptions,
    placement?: { workspaceId: string; cwd: string },
  ) => {
    const serverId = daemonClient.getLastServerInfoMessage()?.serverId;
    const foreignParent =
      options.background === undefined ? foreignParentHandle(options.parent, serverId) : null;
    const resolved = foreignParent
      ? await inheritParentBackground(options, foreignParent)
      : options;
    const agent = await daemonClient.createAgent(
      toDaemonAgentCreateOptions(resolved, placement, daemonClient.getLastServerInfoMessage()),
    );
    return createAgentHandle(agent);
  };
  const terminals = createTerminalActions(daemonClient, async (workspaceId) => {
    const workspace = await createWorkspaceHandle(workspaceId).refresh();
    if (!workspace?.workspaceDirectory) {
      throw new Error(`Workspace ${workspaceId} is not active or has no available directory`);
    }
    return workspace.workspaceDirectory;
  });
  const createWorkspaceHandle = createWorkspaceHandleFactory(
    daemonClient,
    createAgent,
    terminals,
    listenWorkspaces,
  );

  let disposal: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    lifetime.abort();
    scopeOptions?.signal?.removeEventListener("abort", abort);
    agentListeners.clear();
    workspaceListeners.clear();
    disposal = Promise.allSettled([...handles].map((handle) => handle.release())).then(
      (results) => {
        handles.clear();
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "Failed to release API subscriptions");
        return undefined;
      },
    );
    return disposal;
  };
  const abort = () => {
    void dispose().catch((error) => console.error("API subscription cleanup failed", error));
  };
  if (scopeOptions?.signal?.aborted) abort();
  else scopeOptions?.signal?.addEventListener("abort", abort, { once: true });

  const observeEvents: DaemonClient["observeEvents"] = (events, options) =>
    own(() => daemonClient.observeEvents(events, options));

  const subscribeEvent = (
    event: "project.update" | "providers_snapshot_update",
    update: (message: SessionOutboundMessage) => void,
  ): (() => void) => {
    const observation = observeEvents([event]);
    observation.subscribe({ snapshot: () => {}, update });
    return () => {
      void observation
        .release()
        .catch((error) => console.error("Event subscription cleanup failed", error));
    };
  };

  function listWorkspaces(options: PimiWorkspaceListOptions & { subscribe: {} }): Promise<
    PimiWorkspaceListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<PimiWorkspaceListResult>;
    }
  >;
  function listWorkspaces(options?: PimiWorkspaceListOptions): Promise<PimiWorkspaceListResult>;
  async function listWorkspaces(
    options?: PimiWorkspaceListOptions,
  ): Promise<PimiWorkspaceListResult> {
    if (!options?.subscribe) return daemonClient.fetchWorkspaces(options);
    if (options.subscribe.subscriptionId !== undefined)
      throw new Error("Subscription IDs are assigned by the host");
    const subscription = own(() => daemonClient.observeWorkspaces(options));
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "workspace_update")
          for (const listener of workspaceListeners) listener(message.payload);
      },
    });
    return { ...(await subscription.ready), subscription };
  }

  function listAgents(options: PimiAgentListOptions & { subscribe: {} }): Promise<
    PimiAgentListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<PimiAgentListResult>;
    }
  >;
  function listAgents(options?: PimiAgentListOptions): Promise<PimiAgentListResult>;
  async function listAgents(options?: PimiAgentListOptions): Promise<PimiAgentListResult> {
    if (!options?.subscribe) return daemonClient.fetchAgents(options);
    if (options.subscribe.subscriptionId !== undefined)
      throw new Error("Subscription IDs are assigned by the host");
    const subscription = own(() => daemonClient.observeAgents(options));
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "agent_update")
          for (const listener of agentListeners) listener(message.payload);
      },
    });
    return { ...(await subscription.ready), subscription };
  }

  return {
    dispose,
    workspaceLabels: {
      list: (options) => {
        return daemonClient.listWorkspaceLabels(options);
      },
      observe: (options) => {
        return own(() => daemonClient.observeWorkspaceLabels(options));
      },
      set: (options) => {
        return daemonClient.setWorkspaceLabel(options);
      },
    },
    hosts: createHostActions(daemonClient, { own, signal: lifetime.signal, api: createPimiApi }),
    files: {
      list: (cwd, path, requestId) => daemonClient.listDirectory(cwd, path, requestId),
      read: (cwd, path, options) =>
        daemonClient.readFile(cwd, path, options?.requestId, options?.maxBytes, options?.timeout),
      write: (input) => daemonClient.writeFile(input),
      observe: (input) => own(() => daemonClient.observeFile(input)),
      create: (input) => daemonClient.createFileEntry(input),
      rename: (input) => daemonClient.renameFileEntry(input),
      duplicate: (input) => daemonClient.duplicateFileEntry(input),
      remove: (input) => daemonClient.deleteFileEntry(input),
    },
    git: {
      status: (cwd, options) => daemonClient.getCheckoutStatus(cwd, options),
      diff: (cwd, compare, requestId) => daemonClient.getCheckoutDiff(cwd, compare, requestId),
      observeDiff: (cwd, compare, options) =>
        own(() => daemonClient.observeCheckoutDiff(cwd, compare, options)),
      commits: (cwd, requestId) => daemonClient.listCheckoutCommits(cwd, requestId),
      blame: (input) => daemonClient.getLineBlame(input),
      commitFileDiff: (cwd, sha, path, requestId) =>
        daemonClient.getCommitFileDiff(cwd, sha, path, requestId),
    },
    search: {
      workspace: (input, onFiles, requestId) =>
        daemonClient.searchWorkspace(input, onFiles, requestId),
      cancel: (requestId) => daemonClient.cancelWorkspaceSearch(requestId),
    },
    observeEvents,
    terminals,
    projects: {
      list: (options) => daemonClient.listProjects(options),
      subscribe: (handler) => {
        return subscribeEvent("project.update", (message) => {
          if (message.type === "project.update") handler(message.payload);
        });
      },
    },
    workspaces: {
      list: listWorkspaces,
      ref: (workspace) => createWorkspaceHandle(workspace),
      open: (input, requestId) =>
        openWorkspace(daemonClient, createWorkspaceHandle, input, requestId),
      create: async ({ requestId, agent, ...options }) => {
        const result = await daemonClient.createWorkspace(
          {
            ...options,
            ...(agent
              ? {
                  agent: toDaemonAgentCreateOptions(
                    agent,
                    undefined,
                    daemonClient.getLastServerInfoMessage(),
                  ),
                }
              : {}),
          },
          requestId,
        );
        if (result.error || !result.workspace) {
          throw new Error(result.error ?? "The daemon did not create a workspace");
        }
        return createWorkspaceHandle(result.workspace);
      },
      archive: (workspace, requestId) =>
        daemonClient.archiveWorkspace(resolveWorkspaceId(workspace), requestId),
      subscribe: listenWorkspaces,
    },
    agents: {
      list: listAgents,
      ref: (agent) => createAgentHandle(agent),
      create: (options) => createAgent(options),
      subscribe: listenAgents,
    },
    providers: {
      listModels: (provider, options) => daemonClient.listProviderModels(provider, options),
      listModes: (provider, options) => daemonClient.listProviderModes(provider, options),
      listFeatures: ({ provider: providerModel, ...draftConfig }, options) => {
        const { provider, model } = parseProviderModel(providerModel);
        return daemonClient.listProviderFeatures({ ...draftConfig, provider, model }, options);
      },
      listAvailable: (options) => daemonClient.listAvailableProviders(options),
      snapshot: (options) => daemonClient.getProvidersSnapshot(options),
      waitForReady: (options) =>
        waitForProvidersReady(
          daemonClient,
          observeEvents(["providers_snapshot_update"]),
          lifetime.signal,
          options,
        ),
      refresh: (options) => daemonClient.refreshProvidersSnapshot(options),
      diagnostic: (provider, options) => daemonClient.getProviderDiagnostic(provider, options),
      subscribe: (handler) => {
        return subscribeEvent("providers_snapshot_update", (message) => {
          if (message.type === "providers_snapshot_update") handler(message.payload);
        });
      },
    },
    config: {
      get: (requestId) => daemonClient.getDaemonConfig(requestId),
      patch: (patch, requestId) => daemonClient.patchDaemonConfig(patch, requestId),
    },
  };
}

type WorkspaceHandleFactory = (workspace: string | PimiWorkspace) => PimiWorkspaceHandle;
type AgentHandleFactory = (agent: string | PimiAgent) => PimiAgentHandle;
type CreateAgent = (
  options: PimiAgentCreateOptions,
  placement?: { workspaceId: string; cwd: string },
) => Promise<PimiAgentHandle>;

function createWorkspaceHandleFactory(
  daemonClient: DaemonClient,
  createAgent: CreateAgent,
  terminals: PimiTerminalActions,
  listen: (handler: PimiWorkspaceUpdateHandler) => () => void,
): WorkspaceHandleFactory {
  return (workspace) => {
    const id = typeof workspace === "string" ? workspace : workspace.id;
    let current = typeof workspace === "string" ? null : workspace;

    const refresh = async (options?: { requestId?: string }) => {
      current = await daemonClient.findWorkspace(id, options);
      return current;
    };

    return {
      id,
      get projectId() {
        return current?.projectId ?? null;
      },
      get directory() {
        return current?.workspaceDirectory ?? null;
      },
      get name() {
        return current?.name ?? null;
      },
      get status() {
        return current?.status ?? null;
      },
      agents: {
        create: async (options) => {
          const snapshot = current ?? (await refresh());
          if (!snapshot?.workspaceDirectory) {
            throw new Error(`Workspace ${id} has no available directory`);
          }
          return createAgent(
            { ...options, cwd: snapshot.workspaceDirectory },
            { workspaceId: id, cwd: snapshot.workspaceDirectory },
          );
        },
      },
      terminals: {
        create: (options) => terminals.create({ ...options, workspaceId: id }),
        list: (options) => terminals.list({ ...options, workspaceId: id }),
      },
      current: () => current,
      refresh,
      setTitle: (title, requestId) => daemonClient.setWorkspaceTitle(id, title, requestId),
      setBaseBranch: (options) =>
        daemonClient.setWorkspaceBaseBranch({ ...options, workspaceId: id }),
      archive: async (requestId) => {
        const result = await daemonClient.archiveWorkspace(id, requestId);
        if (current) {
          current = { ...current, archivingAt: result.archivedAt };
        }
        return result;
      },
      subscribe: (handler) =>
        listen((update) => {
          if (update.kind === "upsert" && update.workspace.id === id) {
            current = update.workspace;
            handler(update);
          }
          if (update.kind === "remove" && update.id === id) {
            handler(update);
          }
        }),
    };
  };
}

function createAgentHandleFactory(
  daemonClient: DaemonClient,
  listen: (handler: PimiAgentUpdateHandler) => () => void,
  subscribeTimeline: DaemonClient["subscribeAgentTimeline"],
  observeBackgroundWork: () => ReturnType<DaemonClient["observeAgentBackgroundWork"]>,
): AgentHandleFactory {
  return (agent) => {
    const id = typeof agent === "string" ? agent : agent.id;
    let current = typeof agent === "string" ? null : agent;

    let serverId = daemonClient.getLastServerInfoMessage()?.serverId;
    const handle: PimiAgentHandle = {
      id,
      buildForkContext: (options) => daemonClient.buildAgentForkContext(id, options),
      get address() {
        serverId ??= daemonClient.getLastServerInfoMessage()?.serverId;
        if (!serverId) throw new Error("Connect to a host before obtaining an agent address");
        return { serverId, agentId: id };
      },
      timeline: {
        append: (item) => daemonClient.appendAgentTimelineItem(id, item),
        refetch: async (options) => {
          const result = await daemonClient.fetchAgentTimeline(id, options);
          if (result.agent) {
            current = result.agent;
          }
          return result;
        },
        subscribe: (handler) =>
          subscribeTimeline(id, (message) => {
            switch (message.type) {
              case "agent_stream":
                return handler(message.payload);
              case "agent.timeline.subscription_restored":
                return handler({
                  agentId: id,
                  subscriptionId: message.payload.subscriptionId,
                  event: { type: "subscription_restored" },
                });
              case "agent.timeline.error":
                return handler({
                  agentId: id,
                  event: { type: "error", error: message.payload.error },
                });
              case "agent.timeline.replacement":
                return handler({
                  agentId: id,
                  event: { type: "replacement", epoch: message.payload.epoch },
                });
            }
          }),
      },
      backgroundWork: {
        stop: (item, options) => daemonClient.stopAgentBackgroundWork(id, item, options),
        list: (options) => daemonClient.listAgentBackgroundWork(id, options),
        subscribe: (listener, options) => {
          const observation = observeBackgroundWork();
          // Bumped by every delivery so a list answered after a newer update is dropped.
          let sequence = 0;
          let released = false;
          const reportError = (error: unknown) => {
            if (released) return;
            if (options?.onError) options.onError(error);
            else console.error("Background work subscription failed", error);
          };
          observation.subscribe({
            error: reportError,
            snapshot: () => {
              const listed = ++sequence;
              void daemonClient
                .listAgentBackgroundWork(id)
                .then((items) => {
                  if (!released && listed === sequence) listener(items);
                  return undefined;
                })
                .catch(reportError);
            },
            update: (message) => {
              if (message.type !== "agent.background_work.update") return;
              if (message.payload.agentId !== id) return;
              sequence++;
              listener(message.payload.items);
            },
          });
          return () => {
            released = true;
            void observation
              .release()
              .catch((error) =>
                console.error("Background work subscription cleanup failed", error),
              );
          };
        },
      },
      get workspaceId() {
        return current?.workspaceId ?? null;
      },
      get cwd() {
        return current?.cwd ?? null;
      },
      get status() {
        return current?.status ?? null;
      },
      get capabilities() {
        return current?.capabilities ?? null;
      },
      get availableModes() {
        return current?.availableModes ?? null;
      },
      get pendingPermissions() {
        return current?.pendingPermissions ?? null;
      },
      get activeTurn() {
        return current?.activeTurn ?? null;
      },
      get lastUsage() {
        return current?.lastUsage ?? null;
      },
      get lastError() {
        return current?.lastError ?? null;
      },
      get features() {
        return current?.features ?? null;
      },
      get runtimeInfo() {
        return current?.runtimeInfo ?? null;
      },
      get archivedAt() {
        return current?.archivedAt ?? null;
      },
      current: () => current,
      refresh: async (requestId) => {
        const result = await daemonClient.fetchAgent({ agentId: id, requestId });
        current = result?.agent ?? null;
        return result;
      },
      reload: async (options) => {
        await daemonClient.refreshAgent(id, options?.requestId);
        const result = await daemonClient.fetchAgent({ agentId: id });
        current = result?.agent ?? null;
        return result;
      },
      send: async (text, options) => {
        await daemonClient.sendAgentMessage(id, text, options);
      },
      respondToPermission: async ({ requestId, response }) => {
        await daemonClient.respondToPermission(id, requestId, response);
      },
      run: async (text, options) => {
        const { timeoutMs, ...sendOptions } = options ?? {};
        await daemonClient.sendAgentMessage(id, text, sendOptions);
        const result = await daemonClient.waitForFinish(
          id,
          timeoutMs ?? DEFAULT_WAIT_FOR_FINISH_MS,
        );
        if (result.final) {
          current = result.final;
        }
        return result;
      },
      waitForFinish: async (timeoutMs) => {
        const result = await daemonClient.waitForFinish(
          id,
          timeoutMs ?? DEFAULT_WAIT_FOR_FINISH_MS,
        );
        if (result.final) {
          current = result.final;
        }
        return result;
      },
      commands: (options) => daemonClient.listCommands({ agentId: id, ...options }),
      archive: async () => {
        const result = await daemonClient.archiveAgent(id);
        if (current) {
          current = { ...current, archivedAt: result.archivedAt };
        }
        return result;
      },
      detach: async () => {
        await daemonClient.detachAgent(id);
      },
      subscribe: (handler) =>
        listen((update) => {
          if (update.kind === "upsert" && update.agent.id === id) {
            current = update.agent;
            handler(update);
          }
          if (update.kind === "remove" && update.agentId === id) {
            handler(update);
          }
        }),
    };

    return handle;
  };
}

async function openWorkspace(
  daemonClient: DaemonClient,
  createWorkspaceHandle: WorkspaceHandleFactory,
  input: string | PimiWorkspaceOpenOptions,
  requestId?: string,
): Promise<PimiWorkspaceHandle> {
  const options = typeof input === "string" ? { cwd: input, requestId } : input;
  const result = await daemonClient.openProject(options.cwd, options.requestId);
  if (result.error || !result.workspace) {
    throw new Error(result.error ?? `The daemon did not open a workspace for ${options.cwd}`);
  }
  return createWorkspaceHandle(result.workspace);
}

function resolveWorkspaceId(workspace: string | PimiWorkspaceHandle): string {
  return typeof workspace === "string" ? workspace : workspace.id;
}

function foreignParentHandle(
  parent: PimiAgentCreateOptions["parent"],
  serverId: string | undefined,
): PimiAgentHandle | null {
  if (!parent || typeof parent === "string" || !("address" in parent)) return null;
  return parent.address.serverId === serverId ? null : parent;
}

// A host inherits background from a caller it can see. A parent on another host is invisible to
// it, so a handle passes its own value on. A bare foreign address can't; pass background then.
async function inheritParentBackground(
  options: PimiAgentCreateOptions,
  parent: PimiAgentHandle,
): Promise<PimiAgentCreateOptions> {
  const snapshot = parent.current() ?? (await parent.refresh())?.agent;
  return snapshot?.background ? { ...options, background: true } : options;
}

function encodeParent(
  parent: string | AgentAddress | PimiAgentHandle,
  serverId?: string,
): Pick<CreateAgentRequestOptions, "callerAgentId" | "labels"> {
  if (typeof parent === "string") return { callerAgentId: parent };
  const address = "address" in parent ? parent.address : parent;
  if (!serverId) throw new Error("Connect to a host before creating a child");
  return address.serverId === serverId
    ? { callerAgentId: address.agentId, labels: parentAddressLabels(address) }
    : { labels: parentAddressLabels(address) };
}

function parseProviderModel(selection: string): { provider: string; model: string } {
  const separator = selection.indexOf("/");
  if (separator <= 0 || separator === selection.length - 1) {
    throw new Error('Expected config.provider in "provider/model" format');
  }
  return {
    provider: selection.slice(0, separator),
    model: selection.slice(separator + 1),
  };
}

async function waitForProvidersReady(
  daemonClient: DaemonClient,
  observation: ReturnType<DaemonClient["observeEvents"]>,
  signal: AbortSignal,
  options: PimiProviderWaitOptions = {},
): Promise<PimiProviderSnapshotResult> {
  const { timeoutMs = 60_000, ...snapshotOptions } = options;

  try {
    await observation.ready;
    if (signal.aborted) throw new Error("Pimi API is disposed");
    return await new Promise<PimiProviderSnapshotResult>((resolve, reject) => {
      let settled = false;
      let requestId: string | null = null;
      let snapshotCwd: string | undefined;
      const pendingUpdates = new Map<string | undefined, PimiProviderSnapshotUpdate>();
      let latestEntries: PimiProviderSnapshotResult["entries"] = [];

      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      const finish = (snapshot: PimiProviderSnapshotResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(snapshot);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const updateMatches = (update: PimiProviderSnapshotUpdate) => update.cwd === snapshotCwd;

      const unsubscribe = observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "providers_snapshot_update") return;
          const update = message.payload;
          if (!requestId) {
            pendingUpdates.set(update.cwd, update);
            return;
          }
          if (!updateMatches(update)) return;
          latestEntries = update.entries;
          if (update.entries.some((entry) => entry.status === "loading")) return;
          finish({ ...update, requestId });
        },
      });
      const abort = () => fail(new Error("Pimi API is disposed"));
      signal.addEventListener("abort", abort, { once: true });

      const timeout = setTimeout(() => {
        const loading = latestEntries
          .filter((entry) => entry.status === "loading")
          .map((entry) => entry.provider)
          .join(", ");
        fail(
          new Error(
            loading
              ? `Timed out waiting for providers: ${loading}`
              : "Timed out waiting for provider discovery",
          ),
        );
      }, timeoutMs);

      void daemonClient
        .getProvidersSnapshot(snapshotOptions)
        .then((snapshot) => {
          requestId = snapshot.requestId;
          snapshotCwd = snapshot.cwd;
          latestEntries = snapshot.entries;
          if (!snapshot.entries.some((entry) => entry.status === "loading")) {
            finish(snapshot);
            return;
          }
          const pendingUpdate = pendingUpdates.get(snapshotCwd);
          if (pendingUpdate && !pendingUpdate.entries.some((entry) => entry.status === "loading")) {
            finish({ ...pendingUpdate, requestId });
          }
          return undefined;
        })
        .catch(fail);
    });
  } finally {
    await observation.release();
  }
}

function createGeneratedClientId(): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `pimi-sdk-${randomId}`;
}
