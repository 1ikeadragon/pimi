import { createRestartRecovery } from "./agent/restart-recovery/index.js";
import { sendPromptToAgent } from "./agent/agent-prompt.js";
import { generateChatTitle } from "./agent/chat-title-generator.js";
import {
  AskPimiToolSessions,
  createAskPimiMcpHandler,
  PIMI_ASK_MCP_ROUTE,
} from "./agent/pimi-ask-mcp.js";
import { createPimiVoiceCommandHandler } from "./agent/pimi-voice-command.js";
import { createIdleRuntimeCleanup } from "./agent/idle-runtime-cleanup/index.js";
import {
  createFinishSubscriptions,
  createFinishObservation,
  createJsonFinishSubscriptionStore,
} from "./agent/finish-subscriptions/index.js";
import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import type { PluginRegistries } from "@pimi/protocol/plugin-registry";
import { shouldUseTlsForDefaultHostedRelay } from "@pimi/protocol/daemon-endpoints";
import { describeHookWorkspace } from "./plugins/lifecycle/index.js";
import express from "express";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { constants, existsSync, unlinkSync } from "fs";
import { open, rm, stat } from "fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import { getHostName } from "./host-name.js";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import { z } from "zod";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";
import { DEFAULT_PAIRING_APP_BASE_URL } from "./connection-offer.js";

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

export function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${formatHostForHttpUrl(listenTarget.host)}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

export async function fanOutReconciledWorkspaceUpdates(input: {
  sessions: Iterable<{
    syncWorkspaceGitObserversForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
    emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
  }>;
  workspaceIds: readonly string[];
  logger: Pick<Logger, "warn">;
}): Promise<void> {
  await Promise.all(
    Array.from(input.sessions, async (session) => {
      try {
        await session.syncWorkspaceGitObserversForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn(
          { err: error },
          "Failed to sync workspace Git observers after reconciliation",
        );
      }
      try {
        await session.emitWorkspaceUpdatesForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn({ err: error }, "Failed to emit workspace updates after reconciliation");
      }
    }),
  );
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import { createWorkspaceLabelService } from "./workspace-labels/index.js";
import { createGitHubService, runGitHubCli } from "../services/github-service.js";
import { createPaseoWorktree as createRegisteredPaseoWorktree } from "./paseo-worktree-service.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createPaseoWorktreeWorkflow } from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { formatAttachmentContentDisposition } from "./file-download/content-disposition.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { createSpeechSettingsOwner } from "./speech/speech-settings.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { FileCarriedTimelineStore } from "./agent/carried-timeline.js";
import { FileAgentImageStore } from "./agent/agent-images.js";
import { FileSentAttachmentStore } from "./agent/sent-attachments.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { ProjectMemory } from "./project-memory.js";
import { createPimiMemoryHandler } from "./pimi-memory-route.js";
import { PimiSpaces } from "./pimi-spaces.js";
import { searchPimiCodebase } from "./pimi-codebase-index.js";
import { createPimiSpacesHandler } from "./pimi-spaces-route.js";
import {
  PIMI_SPACES_ROUTE,
  PIMI_SPACE_REQUEST_BYTES,
  PIMI_VOICE_COMMAND_ROUTE,
} from "@pimi/protocol/pimi-task";
import {
  createPaseoToolCatalog,
  createPaseoAgentToolManifest,
  type PaseoToolHostDependencies,
} from "./agent/tools/paseo-tools.js";
import type { PaseoToolRuntimeContext } from "./agent/tools/types.js";
import { createAgentProviderRuntime } from "./agent/provider-runtime.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type WorkspaceArchiveContext,
} from "./workspace-registry.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { AutomationService } from "./automation/service.js";
import { compileAutomation } from "./automation/compile.js";
import { homedir } from "node:os";
import { HeartbeatService } from "./heartbeat/service.js";
import { AttackService } from "./attack/service.js";
import { DaemonConfigStore, type MutableDaemonConfig } from "./daemon-config-store.js";
import { createOrchestrationSkills } from "./orchestration-skills/index.js";
import {
  resolveReloadableConfig,
  type ResolvedDaemonSettings,
  type CliConfigOverrides,
} from "./config.js";
import { resolvePaseoToolPolicy } from "./agent/paseo-tool-policy.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { DaemonConfigBrowserToolsPolicy } from "./browser-tools/policy.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  archiveByScope,
  archivePersistedWorkspaceRecord,
  killTerminalsForWorkspace,
  type ActiveWorkspaceRef,
} from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import { closeAllCodeNavigation, closeCodeNavigationWorkspace } from "./code-navigation/index.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { startWorkerTerminalManager } from "../terminal/worker-terminal-manager.js";
import { applyTerminalAgentHookSetting } from "../terminal/agent-hooks/terminal-agent-hook-setting.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { createRelayRuntime, type RelayRuntime } from "./relay-runtime.js";
import { admitSecuredRelaySocket } from "./websocket/secure-relay-ingress.js";
import type { PushNotificationSender } from "./push/index.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProfile,
  AgentSkillSelection,
  EditorLanguageServer,
  FirstAgentContext,
  PluginSource,
  TerminalProfile,
} from "@pimi/protocol/messages";
import { NETWORK_LOG_RETENTION_DAYS_DEFAULT } from "@pimi/protocol/messages";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { type PersistedConfig } from "./persisted-config.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { createWorkspaceScriptsService } from "./session/workspace-scripts/workspace-scripts-service.js";
import { assertWorkspaceAutomationAllowedForWorkspace } from "./workspace-automation-gate.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { withTimeout } from "../utils/promise-timeout.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";
import {
  createRequireBearerMiddleware,
  extractHttpBearerToken,
  isAgentMcpRequestAuthorized,
  PIMI_MEMORY_ROUTE,
  type DaemonAuthConfig,
} from "./auth.js";
import {
  deleteLocalCredential,
  matchesLocalCredential,
  writeLocalCredential,
} from "./local-credential.js";
import { createLocalNetworkPairing } from "./local-network-pairing.js";
import { getDaemonNetworkActivity, startDaemonNetworkLog } from "./network/activity.js";
import { createInboundHttpActivityMiddleware } from "./network/inbound.js";
import { PIMI_LOCAL_PAIRING_ROUTE, PimiLocalPairingRequest } from "@pimi/protocol/connection-offer";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createGitMutationService } from "./session/git-mutation/git-mutation-service.js";
import { workspaceIdsOnCheckout } from "./workspace-directory.js";
import { configureGitProcessPolicy } from "../utils/run-git-command.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import {
  createAgentCommand,
  type CreateAgentCommandDependencies,
} from "./agent/create-agent/create.js";
import { PluginService } from "./plugins/index.js";
import { BuiltinPluginLoader } from "./plugins/builtin/index.js";
import { ManagedPluginSources } from "./plugins/managed-source.js";
import { keepBuiltinProfilesSeeded } from "./agent/profiles/seed.js";

const MCP_DEBUG_BATCH_LIMIT = 10;
const MCP_DEBUG_SECRET = "[redacted]";
const DOWNLOAD_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveAgentMcpClientHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]") {
    return "::1";
  }
  return host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

function createTerminalActivityUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/api/terminal-activity",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

const TerminalActivityReportSchema = z.object({
  terminalId: z.string().min(1),
  token: z.string().min(1),
  state: z.enum(["running", "idle", "needs-input"]),
});

const TERMINAL_ACTIVITY_STATE_MAP = {
  running: "working",
  idle: "idle",
  "needs-input": "attention",
} as const;

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

export function createTerminalActivityRouteHandler(
  terminalManager: TerminalManager,
): express.RequestHandler {
  return async (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = TerminalActivityReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid terminal activity report" });
      return;
    }

    const validation = terminalManager.validateTerminalActivityToken(
      parsed.data.terminalId,
      parsed.data.token,
    );
    if (validation !== "valid") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    try {
      const updated = await terminalManager.setTerminalActivity(
        parsed.data.terminalId,
        TERMINAL_ACTIVITY_STATE_MAP[parsed.data.state],
      );
      if (!updated) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "Failed to update terminal activity" });
    }
  };
}

function describeMcpRequest(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { shape: value === null ? "null" : typeof value };
  }
  const request = value as Record<string, unknown>;
  return {
    shape: "request",
    ...(typeof request.jsonrpc === "string" ? { jsonrpc: request.jsonrpc } : {}),
    ...(typeof request.method === "string" ? { method: request.method } : {}),
    hasId: "id" in request,
    hasParams: "params" in request,
  };
}

function describeMcpDebugPayload(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return describeMcpRequest(value);
  const sampled = value.slice(0, MCP_DEBUG_BATCH_LIMIT).map(describeMcpRequest);
  return {
    shape: "batch",
    count: value.length,
    sampled,
    ...(sampled.length < value.length ? { skipped: value.length - sampled.length } : {}),
  };
}

export type PaseoOpenAIConfig = OpenAiSpeechProviderConfig;
export type PaseoLocalSpeechConfig = LocalSpeechProviderConfig;

export interface PaseoSpeechSttLanguages {
  dictation: string;
  voice: string;
}

export interface PaseoSpeechConfig {
  providers: RequestedSpeechProviders;
  // Where local models live, whether or not a feature currently uses the local provider.
  localModelsDir: string;
  sttLanguages?: PaseoSpeechSttLanguages;
  local?: PaseoLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
      reason: string;
      keepTerminals: boolean;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason: string;
      keepTerminals: boolean;
    };

export interface PaseoDaemonConfig {
  listen: string;
  paseoHome: string;
  daemonVersion?: string;
  desktopManaged?: boolean;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  trustedProxies?: true | string[];
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  usageEnabled?: boolean;
  browserToolsEnabled?: boolean;
  git?: {
    maxProcessesPerSecond: number;
    maxProcessConcurrency: number;
  };
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: TerminalProfile[];
  editorLanguageServers?: EditorLanguageServer[];
  agentProfiles?: AgentProfile[];
  agentProfilesRemovedBuiltins?: string[];
  skillSelection?: AgentSkillSelection;
  pluginsEnabled?: boolean;
  plugins?: Record<string, PluginSource>;
  pluginRegistries?: PluginRegistries;
  pluginRegistryUrl?: string;
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEnabledMutable?: boolean;
  relayRequireProtectedSecurity?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  serviceProxy?: {
    publicBaseUrl: string | null;
    standaloneListen: string | null;
  };
  appBaseUrl?: string;
  auth?: DaemonAuthConfig;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  logNetworkEnabled?: boolean;
  logNetworkRetentionDays?: number;
  idleRuntimeCleanup?: boolean;
  resumeOnStartup?: boolean;
  resumePrompt?: string;
  providerCatalogRefreshTimeoutMs?: number;
  metadataGeneration?: NonNullable<PersistedConfig["agents"]>["metadataGeneration"];
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pushNotificationSender?: PushNotificationSender;
  managedProcesses?: ManagedProcessRegistry;
  configReload?: {
    env: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
    overrideControlledPaths: string[];
    startupPersisted: PersistedConfig;
  };
}

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  serviceProxy: ServiceProxySubsystem;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  browserToolsBroker: BrowserToolsBroker;
  start(): Promise<void>;
  /** Stops the daemon. Terminals keep running for the next daemon only with keepTerminals. */
  stop(options?: { keepTerminals?: boolean }): Promise<void>;
  getListenTarget(): ListenTarget | null;
  getServerId(): string;
}

export interface PaseoDaemonDependencies {
  builtinPlugins?: BuiltinPluginLoader;
}

function resolveBuiltinPluginLoader(dependencies: PaseoDaemonDependencies): BuiltinPluginLoader {
  return dependencies.builtinPlugins ?? new BuiltinPluginLoader();
}

function createBootstrapManagedProcessRegistry(
  config: Pick<PaseoDaemonConfig, "paseoHome" | "managedProcesses">,
  logger: Logger,
): ManagedProcessRegistry {
  if (config.managedProcesses) {
    return config.managedProcesses;
  }

  return createManagedProcessRegistry({
    paseoHome: config.paseoHome,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
}

async function reconcileManagedProcessLedger(
  managedProcesses: ManagedProcessRegistry,
  logger: Logger,
): Promise<void> {
  const reapResult = await managedProcesses.reapStale();
  if (reapResult.checked > 0 || reapResult.errors.length > 0) {
    logger.info(reapResult, "Managed helper process ledger reconciled");
  }
}

function resolveExpressTrustProxySetting(config: PaseoDaemonConfig): true | string[] {
  return config.trustedProxies ?? ["loopback"];
}

function createInitialRelayConfig(config: ResolvedDaemonSettings): MutableDaemonConfig["relay"] {
  return {
    enabled: config.relayEnabled ?? false,
    requireProtectedSecurity: config.relayRequireProtectedSecurity ?? true,
  };
}

function resolveReloadEnv(config: PaseoDaemonConfig): NodeJS.ProcessEnv {
  return config.configReload?.env ?? process.env;
}

function resolveMetadataGeneration(config: ResolvedDaemonSettings["metadataGeneration"]) {
  return {
    providers: config?.providers ?? [],
    ...(config?.features ? { features: config.features } : {}),
    autoNaming: config?.autoNaming !== false,
  };
}

function createInitialLogConfig(config: ResolvedDaemonSettings): MutableDaemonConfig["log"] {
  return {
    network: {
      enabled: config.logNetworkEnabled ?? true,
      retentionDays: config.logNetworkRetentionDays ?? NETWORK_LOG_RETENTION_DAYS_DEFAULT,
    },
  };
}

function createInitialMutableDaemonConfig(config: ResolvedDaemonSettings): MutableDaemonConfig {
  const providers = config.providerOverrides ?? {};

  const initialConfig: MutableDaemonConfig = {
    relay: createInitialRelayConfig(config),
    mcp: {
      enabled: config.mcpEnabled ?? true,
      injectIntoAgents: config.mcpInjectIntoAgents ?? true,
    },
    ...(config.hostnames !== undefined ? { hostnames: config.hostnames } : {}),
    cors: { allowedOrigins: config.corsAllowedOrigins },
    trustedProxies: config.trustedProxies ?? ["loopback"],
    git: config.git ?? resolveGitProcessPolicy({ env: process.env }),
    app: { baseUrl: config.appBaseUrl ?? DEFAULT_PAIRING_APP_BASE_URL },
    ...(config.providerCatalogRefreshTimeoutMs !== undefined
      ? { catalogRefreshTimeoutMs: config.providerCatalogRefreshTimeoutMs }
      : {}),
    usage: { enabled: config.usageEnabled === true },
    browserTools: { enabled: config.browserToolsEnabled ?? false },
    providers,
    metadataGeneration: resolveMetadataGeneration(config.metadataGeneration),
    autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: config.enableTerminalAgentHooks ?? false,
    log: createInitialLogConfig(config),
    idleRuntimeCleanup: config.idleRuntimeCleanup !== false,
    resumeOnStartup: config.resumeOnStartup === true,
    resumePrompt: config.resumePrompt ?? "Resume working.",
    appendSystemPrompt: config.appendSystemPrompt ?? "",
    pluginsEnabled: config.pluginsEnabled ?? false,
    plugins: config.plugins ?? {},
    skills: { selection: config.skillSelection },
  };

  if (config.terminalProfiles !== undefined) {
    initialConfig.terminalProfiles = config.terminalProfiles;
  }

  if (config.editorLanguageServers !== undefined) {
    initialConfig.editorLanguageServers = config.editorLanguageServers;
  }

  if (config.agentProfiles !== undefined) {
    initialConfig.agentProfiles = config.agentProfiles;
  }

  if (config.agentProfilesRemovedBuiltins !== undefined) {
    initialConfig.agentProfilesRemovedBuiltins = config.agentProfilesRemovedBuiltins;
  }

  return initialConfig;
}

export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger,
  dependencies: PaseoDaemonDependencies = {},
): Promise<PaseoDaemon> {
  configureGitProcessPolicy(config.git ?? resolveGitProcessPolicy({ env: process.env }));
  const logger = rootLogger.child({ module: "bootstrap" });
  await rm(path.join(config.paseoHome, "push-tokens.json"), { force: true }).catch((error) => {
    logger.warn({ err: error }, "Failed to remove the retired push token cache");
  });
  const obsoleteTimelineDirectory = path.join(config.paseoHome, "agent-timelines");
  await rm(obsoleteTimelineDirectory, { recursive: true, force: true }).catch((error) => {
    logger.warn(
      { err: error, path: obsoleteTimelineDirectory },
      "Failed to remove obsolete agent timeline data",
    );
  });
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = config.daemonVersion ?? resolveDaemonVersion(import.meta.url);
  const relayEndpoint = config.relayEndpoint;
  const initialMutableConfig = createInitialMutableDaemonConfig({
    ...config,
    relayEnabled: Boolean(relayEndpoint && config.relayEnabled),
  });
  const speechService = createSpeechService({
    logger,
    openaiConfig: config.openai,
    speechConfig: config.speech,
  });
  logger.info({ elapsed: elapsed() }, "Speech service created");
  const daemonConfigStore = new DaemonConfigStore(config.paseoHome, initialMutableConfig, logger, {
    relayEnabledMutable: config.relayEnabledMutable ?? true,
    relayConfigured: Boolean(relayEndpoint),
    startupPersisted: config.configReload?.startupPersisted,
    speech: createSpeechSettingsOwner({
      paseoHome: config.paseoHome,
      env: resolveReloadEnv(config),
      speechService,
    }),
    reloadSource: {
      resolve: (persisted) => {
        const reloaded = resolveReloadableConfig(persisted, {
          env: resolveReloadEnv(config),
          cli: config.configReload?.cli,
        });
        return {
          mutable: createInitialMutableDaemonConfig({
            ...reloaded,
            relayEnabled: Boolean(relayEndpoint && reloaded.relayEnabled),
          }),
          overrideControlledPaths: reloaded.overrideControlledPaths,
        };
      },
    },
  });
  keepBuiltinProfilesSeeded(daemonConfigStore, logger);
  const networkLog = startDaemonNetworkLog({
    home: config.paseoHome,
    getSettings: () => daemonConfigStore.get().log.network,
    onError: (error, message) => logger.warn({ err: error }, message),
  });
  daemonConfigStore.onFieldChange("log.network", () => void networkLog.sweep());
  const orchestrationSkills = createOrchestrationSkills(daemonConfigStore);
  void orchestrationSkills.autoUpdate().catch((error) => {
    logger.error({ err: error }, "Failed to maintain orchestration skills at startup");
  });
  const browserToolsPolicy = new DaemonConfigBrowserToolsPolicy(daemonConfigStore);
  const browserToolsBroker = new BrowserToolsBroker({});
  const pluginRuntime: PluginService = new PluginService(logger, daemonConfigStore, daemonVersion, {
    usageAgents: {
      hasAgent: (id) => agentManager.getAgent(id) !== null,
      usageSession: (id) => agentManager.usageSession(id),
    },
    managedSources: new ManagedPluginSources(config.paseoHome, {
      registries: config.pluginRegistries,
      defaultUrl: config.pluginRegistryUrl,
    }),
    builtinPlugins: resolveBuiltinPluginLoader(dependencies),
    settingsDirectory: path.join(config.paseoHome, "plugin-settings"),
  });

  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  const managedProcesses = createBootstrapManagedProcessRegistry(config, logger);
  // Reconcile the helper-process ledger in the background so it never blocks the
  // daemon from coming up; terminating a live leftover can take a few seconds.
  // Best-effort, so a failure is logged here rather than crashing startup.
  void reconcileManagedProcessLedger(managedProcesses, logger).catch((error) => {
    logger.warn({ err: error }, "Failed to reconcile managed helper process ledger");
  });
  let relayRuntime: RelayRuntime | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({
    ttlMs: downloadTokenTtlMs,
  });

  // The per-run secret authenticates daemon-owned MCP clients even when the
  // daemon has only a password hash. Give each agent a derived credential so
  // the endpoint can bind private tools to its caller ID.
  const agentMcpAuthToken = randomUUID();
  const agentMcpTokenForCaller = (agentId: string) =>
    createHmac("sha256", agentMcpAuthToken).update(agentId).digest("base64url");

  const listenTarget = parseListenString(config.listen);

  const app = express();
  app.set("trust proxy", resolveExpressTrustProxySetting(config));
  daemonConfigStore.onFieldChange("trustedProxies", (value) => {
    app.set("trust proxy", value ?? ["loopback"]);
  });
  let boundListenTarget: ListenTarget | null = null;
  let workspaceRegistry: FileBackedWorkspaceRegistry | null = null;
  const terminalManager = await startWorkerTerminalManager({
    paseoHome: config.paseoHome,
    paseoVersion: daemonVersion,
    logger,
    getTerminalActivityUrl: () => createTerminalActivityUrl(boundListenTarget),
  });
  applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });

  const serviceProxyPublicBaseUrl = config.serviceProxy?.publicBaseUrl
    ? config.serviceProxy.publicBaseUrl
    : null;
  const serviceProxy = createServiceProxySubsystem({
    logger,
    publicBaseUrl: serviceProxyPublicBaseUrl,
  });
  const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
  const workspaceSetupRuntime = new WorkspaceSetupRuntime();
  let configuredHostnames = config.hostnames ?? config.allowedHosts;
  let appBaseUrl = config.appBaseUrl ?? DEFAULT_PAIRING_APP_BASE_URL;
  daemonConfigStore.onFieldChange("hostnames", (value) => {
    configuredHostnames = value as HostnamesConfig | undefined;
  });
  daemonConfigStore.onFieldChange("app.baseUrl", (value) => {
    appBaseUrl = typeof value === "string" ? value : DEFAULT_PAIRING_APP_BASE_URL;
  });
  let wsServer: VoiceAssistantWebSocketServer | null = null;
  let serviceProxyListenTarget: ListenTarget | null = null;
  const scriptHealthMonitor = new ScriptHealthMonitor({
    serviceProxy,
    onChange: createScriptStatusEmitter({
      sessions: () =>
        wsServer?.listSessions().map((session) => ({
          emit: (message) => session.emitServerMessage(message),
        })) ?? [],
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      resolveWorkspaceDirectory: async (workspaceId) =>
        (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
      logger,
      serviceProxyPublicBaseUrl,
    }),
  });
  const handleBranchChange = createBranchChangeRouteHandler({
    serviceProxy,
    onRoutesChanged: (workspaceId) => {
      scriptHealthMonitor.invalidateWorkspace(workspaceId);
    },
    logger,
  });

  // First, so every request is recorded, including ones the host check or auth turns away.
  app.use(createInboundHttpActivityMiddleware(getDaemonNetworkActivity));

  // Service proxy classifies service hosts before daemon auth/route fallthrough.
  // Registered service hosts proxy directly; known service namespaces without a
  // route return 404 and never reach daemon APIs.
  app.use(serviceProxy.middleware());

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }

  // CORS - allow same-origin + configured origins
  const fixedAllowedOrigins = [
    // Packaged desktop renderers use the custom paseo:// protocol scheme.
    "paseo://app",
    // For TCP, add localhost variants
    ...(listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
        ]
      : []),
  ];
  const allowedOrigins = new Set([...config.corsAllowedOrigins, ...fixedAllowedOrigins]);
  daemonConfigStore.onFieldChange("cors.allowedOrigins", (value) => {
    allowedOrigins.clear();
    for (const origin of [...((value as string[] | undefined) ?? []), ...fixedAllowedOrigins]) {
      allowedOrigins.add(origin);
    }
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Local, harmless, and token-gated; deliberately skips daemon auth.
  app.post(
    "/api/terminal-activity",
    express.json(),
    createTerminalActivityRouteHandler(terminalManager),
  );

  let localCredential: string | null = null;
  const daemonAuth = { ...config.auth, localCredential: () => localCredential };
  app.use(
    createRequireBearerMiddleware(daemonAuth, (context) => {
      logger.warn(context, "Rejected HTTP request with invalid daemon password");
    }),
  );

  const requireLocalPimi =
    (feature: string): express.RequestHandler =>
    (req, res, next) => {
      const token = extractHttpBearerToken(req.header("authorization"));
      if (
        !isLoopbackRemoteAddress(req.socket.remoteAddress) ||
        req.headers.origin !== undefined ||
        !localCredential ||
        !token ||
        !matchesLocalCredential(localCredential, token)
      ) {
        res.status(403).json({ error: `${feature} is available only from the local Pimi app.` });
        return;
      }
      next();
    };
  const localNetworkPairing = createLocalNetworkPairing({
    serverId,
    daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
    daemonKeyPair: daemonKeyPair.keyPair,
    hasPassword: Boolean(daemonAuth.password),
    logger: logger.child({ module: "local-pairing" }),
    attach: (...args) => {
      if (!wsServer) throw new Error("The local host is still starting.");
      return wsServer.attachExternalSocket(...args);
    },
  });
  app.post(
    PIMI_LOCAL_PAIRING_ROUTE,
    requireLocalPimi("Local pairing"),
    express.json({ limit: "1kb", inflate: false }),
    (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const input = PimiLocalPairingRequest.safeParse(req.body);
      if (!input.success) {
        res.status(400).json({ error: "Invalid local pairing request." });
        return;
      }
      void localNetworkPairing.request(input.data).then(
        (status) => res.json(status),
        (error: unknown) =>
          res.status(409).json({
            error: error instanceof Error ? error.message : "Could not change local pairing.",
          }),
      );
    },
  );
  const pimiSpaces = new PimiSpaces(config.paseoHome);
  const parseSpacesRequest = express.json({ limit: PIMI_SPACE_REQUEST_BYTES, inflate: false });
  app.post(
    PIMI_SPACES_ROUTE,
    requireLocalPimi("Spaces"),
    (req, res, next) =>
      parseSpacesRequest(req, res, (error?: { status?: number }) => {
        if (!error) return next();
        const status = error.status === 413 ? 413 : 400;
        res.status(status).json({
          error: status === 413 ? "The pasted image is too large." : "Invalid Spaces request.",
        });
      }),
    createPimiSpacesHandler(pimiSpaces, (error) =>
      logger.error({ err: error }, "Pimi Spaces request failed"),
    ),
  );
  app.use(express.json());

  // Serve static files from public directory
  app.use("/public", express.static(staticDir));

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      status: "server_info",
      serverId,
      hostname: getHostName(),
      version: daemonVersion,
      listen: formatListenTarget(boundListenTarget ?? listenTarget),
    });
  });

  const handleFileDownload = async (req: express.Request, res: express.Response): Promise<void> => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;

    if (!token) {
      res.status(400).json({ error: "Missing download token" });
      return;
    }

    const entry = downloadTokenStore.consumeToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
      const fileStats = await fileHandle.stat();
      if (res.destroyed) {
        return;
      }
      if (!fileStats.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader("Content-Disposition", formatAttachmentContentDisposition(entry.fileName));
      res.setHeader("Content-Length", fileStats.size.toString());

      const stream = fileHandle.createReadStream();
      fileHandle = null;
      res.once("close", () => stream.destroy());
      stream.on("error", (err) => {
        logger.error({ err }, "Failed to stream download");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      logger.error({ err }, "Failed to download file");
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      }
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  };

  app.get("/api/files/download", (req, res) => {
    void handleFileDownload(req, res);
  });

  const httpServer = createHTTPServer(app);

  // Script proxy WebSocket upgrade handler — must be registered before the
  // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
  // script-bound upgrades are forwarded first. The handler is a no-op for
  // requests that don't match a registered script route.
  httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));

  if (config.serviceProxy?.standaloneListen) {
    serviceProxyListenTarget = parseListenString(config.serviceProxy.standaloneListen);
  }

  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(config.paseoHome, "projects", "projects.json"),
    logger,
  );
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(config.paseoHome, "projects", "workspaces.json"),
    logger,
  );
  const workspaceLabelService = createWorkspaceLabelService({
    paseoHome: config.paseoHome,
    workspaceRegistry,
  });
  const github = createGitHubService();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    deps: {
      forgeOverrides: { github },
    },
  });
  const workspaceRuntimeStore = createWorkspaceRuntimeStore();
  workspaceGitService.onSnapshotUpdated((snapshot) => workspaceRuntimeStore.set(snapshot));
  workspaceRegistry.subscribeToMutations(async (mutation) => {
    if (mutation.kind === "remove" && mutation.workspace) {
      const cwd = path.resolve(mutation.workspace.cwd);
      const workspaces = await workspaceRegistry.listActive();
      const hasActiveWorkspace = workspaces.some(
        (workspace) => !workspace.archivedAt && path.resolve(workspace.cwd) === cwd,
      );
      if (!hasActiveWorkspace) workspaceRuntimeStore.remove(cwd);
    }
    if (mutation.kind === "archive" && mutation.workspace) {
      pluginRuntime.emit("workspace.archive.after", {
        workspace: describeHookWorkspace(mutation.workspace),
      });
    }
  });
  const workspaceProvisioning = createWorkspaceProvisioningService({
    lifecycle: pluginRuntime,
    serverId,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    isDirectory: async (target) => (await stat(target).catch(() => null))?.isDirectory() ?? false,
    logger,
  });
  const agentProviderRuntime = await createAgentProviderRuntime({
    paseoHome: config.paseoHome,
    logger,
    snapshotManager: {
      refreshTimeoutMs: config.providerCatalogRefreshTimeoutMs,
      runtimeSettings: config.agentProviderSettings,
      providerOverrides: config.providerOverrides,
      workspaceGitService,
      managedProcesses,
      isDev: config.isDev === true,
      extraClients: config.agentClients,
    },
  });
  const providerSnapshotManager = agentProviderRuntime.snapshotManager;
  daemonConfigStore.onFieldChange("catalogRefreshTimeoutMs", (value) => {
    providerSnapshotManager.setRefreshTimeoutMs(typeof value === "number" ? value : undefined);
  });
  daemonConfigStore.onFieldChange("git.maxProcessesPerSecond", () => {
    const git = daemonConfigStore.get().git;
    if (git) configureGitProcessPolicy(git);
  });
  daemonConfigStore.onFieldChange("git.maxProcessConcurrency", () => {
    const git = daemonConfigStore.get().git;
    if (git) configureGitProcessPolicy(git);
  });
  const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
  const agentManager = new AgentManager({
    pluginLifecycle: pluginRuntime,
    pluginAgentTools: pluginRuntime,
    clients: initialAgentManagerState.clients,
    providerDefinitions: initialAgentManagerState.providerDefinitions,
    registry: agentStorage,
    carriedTimelines: new FileCarriedTimelineStore(
      path.join(config.paseoHome, "agent-carried-timelines"),
      logger,
    ),
    agentImages: new FileAgentImageStore(path.join(config.paseoHome, "agent-images"), logger),
    sentAttachments: new FileSentAttachmentStore(
      path.join(config.paseoHome, "agent-sent-attachments"),
      logger,
    ),
    appendSystemPrompt: config.appendSystemPrompt,
    onWorkspaceStateMayHaveChanged: ({ cwd }) => {
      workspaceGitService.onWorkspaceStateMayHaveChanged(cwd);
    },
    isAutoNamingEnabled: () => daemonConfigStore.get().metadataGeneration.autoNaming !== false,
    generateChatTitle: (manager, agent, firstPrompt) =>
      generateChatTitle({
        manager,
        agent,
        firstPrompt,
        providerSnapshotManager,
        daemonConfig: daemonConfigStore.get(),
        workspaceGitService,
        logger,
      }),
    mcpAuthToken: agentMcpAuthToken,
    mcpCallerAuthToken: agentMcpTokenForCaller,
    resolvePaseoToolPolicy: (provider) =>
      resolvePaseoToolPolicy(provider, daemonConfigStore.get().providers),
    isSkillAvailable: (name) => orchestrationSkills.isSkillAvailable(name),
    logger,
  });
  const askPimiSessions = new AskPimiToolSessions();
  const handleAskPimiTools = createAskPimiMcpHandler(askPimiSessions, () =>
    logger.warn("Ask Pimi tool request failed"),
  );
  app.all(PIMI_ASK_MCP_ROUTE, (req, res, next) => {
    // Only a harness started on this machine by an Ask Pimi turn calls this route.
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress) || req.headers.origin !== undefined) {
      res.status(403).json({ error: "Ask Pimi tools are available only on this host." });
      return;
    }
    void handleAskPimiTools(req, res, next);
  });
  app.post(
    PIMI_VOICE_COMMAND_ROUTE,
    requireLocalPimi("Ask Pimi"),
    createPimiVoiceCommandHandler({
      manager: agentManager,
      providerSnapshotManager,
      readConfig: () => daemonConfigStore.get(),
      createToolCatalog: (provider) => {
        const { mcp, providers } = daemonConfigStore.get();
        return createPaseoToolCatalog({
          ...createAgentToolHostDependencies({
            // A local Ask Pimi command gets its own bounded tool list. The
            // injection switch controls tools exposed to regular chats.
            paseoToolPolicy: mcp.enabled
              ? resolvePaseoToolPolicy(provider, providers)
              : { enabled: false },
          }),
          voiceCommand: true,
        });
      },
      spaces: pimiSpaces,
      sessions: askPimiSessions,
      toolsUrl: () => {
        const agentTools = createAgentMcpBaseUrl(boundListenTarget);
        return agentTools ? new URL(PIMI_ASK_MCP_ROUTE, agentTools).toString() : null;
      },
      logger,
    }),
  );
  const syncPluginProviders = () => {
    agentManager.updateProviderRegistry(
      providerSnapshotManager.replacePluginProviders(pluginRuntime.getProviderRegistrations()),
    );
  };
  const unsubscribePluginProviders =
    pluginRuntime.subscribeProviderRegistrations(syncPluginProviders);

  const unsubscribePluginSessionChanges = pluginRuntime.subscribeSessionOpenChanges(() => {
    agentManager.invalidatePluginSessions();
  });

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage,
  );
  await agentStorage.initialize();
  const restartRecovery = createRestartRecovery({
    storage: agentStorage,
    settings: () => ({
      enabled: daemonConfigStore.get().resumeOnStartup === true,
      prompt: daemonConfigStore.get().resumePrompt ?? "Resume working.",
    }),
    eligible: async (record) =>
      !record.workspaceId || !(await workspaceRegistry?.get(record.workspaceId))?.archivedAt,
    dispatch: (agentId, prompt) =>
      sendPromptToAgent({ agentId, prompt, agentManager, agentStorage, logger, unarchive: false }),
    report: (agentId, err) => logger.error({ agentId, err }, "Agent restart recovery failed"),
  });
  await restartRecovery.prepareStartup();
  logger.info({ elapsed: elapsed() }, "Agent storage initialized");
  await Promise.all([projectRegistry.initialize(), workspaceRegistry.initialize()]);
  await workspaceLabelService.initialize();
  logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
  const teardownArchivedWorkspaceRuntime = (workspaceId: string): void => {
    closeCodeNavigationWorkspace(workspaceId);
    scriptRuntimeStore.removeForWorkspace(workspaceId);
    releaseWorkspaceServicePortPlan(workspaceId);
  };
  const workspaceReconciliation = new WorkspaceReconciliationService({
    serverId,
    projectRegistry,
    workspaceRegistry,
    logger,
    workspaceGitService,
    onProjectUpdate: (update) => wsServer?.publishProjectUpdate(update),
    onWorkspaceArchived: teardownArchivedWorkspaceRuntime,
    onWorkspacesChanged: async (workspaceIds) => {
      await fanOutReconciledWorkspaceUpdates({
        sessions: wsServer?.listSessions() ?? [],
        workspaceIds,
        logger,
      });
    },
  });
  await workspaceReconciliation.start();
  void workspaceReconciliation.reconcileNow().catch((error) => {
    logger.warn({ err: error }, "Initial workspace reconciliation failed");
  });
  const checkoutDiffManager = new CheckoutDiffManager({
    logger,
    paseoHome: config.paseoHome,
    workspaceGitService,
    workspaceRuntimeStore,
  });
  const archiveWorkspaceRecordExternal = async (
    workspaceId: string,
    context?: WorkspaceArchiveContext,
  ) => {
    const existingWorkspace = await archivePersistedWorkspaceRecord({
      workspaceId,
      workspaceRegistry,
      context,
    });
    if (!existingWorkspace || existingWorkspace.archivedAt) return;
    teardownArchivedWorkspaceRuntime(workspaceId);
  };
  // external path→workspace adapter, not ownership: archive-by-path requests that
  // arrive with a worktree path and no workspaceId (CLI).
  const findWorkspaceIdForCwdExternal = async (cwd: string): Promise<string | null> => {
    // Explicit archive administration must prefer an archived exact match to an active ancestor.
    return resolveWorkspaceIdForPath(cwd, await workspaceRegistry.listAll());
  };
  const ensureWorkspaceForCreateExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { background?: boolean; callerWorkspaceId?: string },
  ): Promise<string> => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      cwd,
      resolveFirstAgentPromptTitle(firstAgentContext),
      undefined,
      context,
    );
    if (firstAgentContext) {
      workspaceAutoName.scheduleForDirectory({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        firstAgentContext,
      });
    }
    return workspace.workspaceId;
  };
  const listActiveWorkspacesExternal = async (): Promise<ActiveWorkspaceRef[]> => {
    const workspaces = await workspaceRegistry.listActive();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
        worktreeRoot: workspace.worktreeRoot,
        isPaseoOwnedWorktree: workspace.isPaseoOwnedWorktree,
        mainRepoRoot: workspace.mainRepoRoot,
      }));
  };
  const markWorkspaceArchivingExternal = (workspaceIds: Iterable<string>, archivingAt: string) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listSessions() ?? []) {
      session.markWorkspaceArchivingForExternalMutation(workspaceIdList, archivingAt);
    }
  };
  const clearWorkspaceArchivingExternal = (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listSessions() ?? []) {
      session.clearWorkspaceArchivingForExternalMutation(workspaceIdList);
    }
  };
  const emitWorkspaceUpdatesExternal = async (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    await Promise.all(
      (wsServer?.listSessions() ?? []).map((session) =>
        session.emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIdList),
      ),
    );
  };
  const ensureWorkspaceForCreateAndBroadcastExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { background?: boolean; callerWorkspaceId?: string },
  ): Promise<string> => {
    const workspaceId = await ensureWorkspaceForCreateExternal(cwd, firstAgentContext, context);
    await emitWorkspaceUpdatesExternal([workspaceId]);
    return workspaceId;
  };
  const emitWorkspaceUpdateForCwdExternal = async (cwd: string) => {
    const workspaceIds = workspaceIdsOnCheckout(await workspaceRegistry.listActive(), cwd);
    await emitWorkspaceUpdatesExternal(workspaceIds);
  };
  const emitExternalSessionMessage = (message: SessionOutboundMessage) => {
    wsServer?.broadcast(wrapSessionMessage(message));
  };
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager,
    workspaceRegistry,
    workspaceGitService,
    providerSnapshotManager,
    readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration }),
    gitMutation: createGitMutationService({
      workspaceGitService,
      logger,
    }),
    emitWorkspaceUpdateForCwd: emitWorkspaceUpdateForCwdExternal,
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      await emitWorkspaceUpdatesExternal([workspaceId]);
    },
    logger,
  });

  setupAutoArchiveOnMerge({
    paseoHome: config.paseoHome,
    paseoWorktreesBaseRoot: config.worktreesRoot,
    daemonConfigStore,
    workspaceGitService,
    github,
    agentManager,
    agentStorage,
    terminalManager,
    logger,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    getAutoArchivedChangeRequestUrl: async (workspaceId) =>
      (await workspaceRegistry.get(workspaceId))?.autoArchivedChangeRequestUrl ?? null,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
  });

  const createPaseoWorktreeForTools = async (
    input: Parameters<typeof createPaseoWorktreeWorkflow>[1],
    serviceOptions?: Parameters<typeof createPaseoWorktreeWorkflow>[2],
  ) => {
    return createPaseoWorktreeWorkflow(
      {
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        createPaseoWorktree: async (workflowInput, workflowOptions) => {
          return createRegisteredPaseoWorktree(workflowInput, {
            lifecycle: pluginRuntime,
            github,
            ...(workflowOptions?.resolveDefaultBranch
              ? {
                  resolveDefaultBranch: workflowOptions.resolveDefaultBranch,
                }
              : {}),
            workspaceGitService,
            workspaceProvisioning,
          });
        },
        warmWorkspaceGitData: async (workspace) => {
          await Promise.all(
            wsServer
              ?.listSessions()
              .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? [],
          );
        },
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          workspaceAutoName.scheduleForWorktree(autoNameInput),
        emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
          await emitWorkspaceUpdatesExternal([workspaceId]);
        },
        cacheWorkspaceSetupSnapshot: () => {},
        startWorkspaceSetup: (workspaceId, operation) =>
          workspaceSetupRuntime.start(workspaceId, operation),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        emit: emitExternalSessionMessage,
        sessionLogger: logger,
        terminalManager,
        serviceProxy,
        scriptRuntimeStore,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
        serviceProxyPublicBaseUrl,
        onScriptsChanged: null,
      },
      input,
      serviceOptions,
    );
  };

  const createAgentCommandDependencies: CreateAgentCommandDependencies = {
    agentManager,
    agentStorage,
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    terminalManager,
    providerSnapshotManager,
    createPaseoWorktree: createPaseoWorktreeForTools,
    ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
    getAgentProfiles: () => daemonConfigStore.get().agentProfiles ?? [],
  };
  const createAgent = (input: Parameters<typeof createAgentCommand>[1]) =>
    createAgentCommand(createAgentCommandDependencies, input);
  const createAutomationDirectoryWorkspaceExternal = async (input: {
    cwd: string;
    title: string;
  }) => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      input.cwd,
      input.title,
      undefined,
      { expectsInitialAgent: true, titleManuallySet: true },
    );
    await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
    return workspace;
  };
  const createAutomationWorktreeExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const result = await createPaseoWorktreeForTools({
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([result.workspace.workspaceId]);
    return result;
  };
  const archiveAutomationWorkspaceExternal = async (
    workspaceId: string,
    options: { keepDirectory: boolean },
  ) => {
    await archiveByScope(
      {
        paseoHome: config.paseoHome,
        paseoWorktreesBaseRoot: config.worktreesRoot,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          killTerminalsForWorkspace(
            {
              terminalManager,
              sessionLogger: logger,
            },
            workspaceIdToKill,
          ),
        stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        sessionLogger: logger,
      },
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "automation-run-workspace",
        keepDirectory: options.keepDirectory,
      },
    );
  };
  const automationService = new AutomationService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    createAgent,
    createDirectoryWorkspace: createAutomationDirectoryWorkspaceExternal,
    createWorktreeWorkspace: createAutomationWorktreeExternal,
    archiveWorkspace: archiveAutomationWorkspaceExternal,
    getAgentProfiles: () => daemonConfigStore.get().agentProfiles ?? [],
    gh: (args) => runGitHubCli(args, { cwd: homedir() }),
    compile: (input) =>
      compileAutomation(
        {
          agentManager,
          providerSnapshotManager,
          getDaemonConfig: () => daemonConfigStore.get(),
          getAgentProfiles: () => daemonConfigStore.get().agentProfiles ?? [],
          logger,
        },
        input,
      ),
  });
  await automationService.start();
  const attackService = new AttackService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    agentStorage,
    createAgent,
    // Session delivery only reaches sockets that subscribed to the event category (see
    // sessionEventCategory), so the desktop app subscribes with observeEvents.
    emit: (message) => {
      for (const session of wsServer?.listSessions() ?? []) session.emitServerMessage(message);
    },
  });
  await attackService.start();
  const heartbeatService = new HeartbeatService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    agentStorage,
  });
  await heartbeatService.start();

  agentManager.setAgentArchivedCallback(async (agentId) => {
    try {
      await heartbeatService.deleteForAgent(agentId);
    } catch (error) {
      logger.warn({ err: error, agentId }, "Failed to delete heartbeats for archived agent");
    }
  });
  logger.info({ elapsed: elapsed() }, "Automation and heartbeat services initialized");
  logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
  // Startup loads persisted agent history once before restoring the registry.
  const persistedRecords = await agentStorage.listAll();
  logger.info(
    { elapsed: elapsed() },
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
  );
  logger.info(
    "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
  );
  logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");

  const finishSubscriptions = createFinishSubscriptions({
    store: createJsonFinishSubscriptionStore(config.paseoHome),
    serverId,
    logger,
    messages: () => {
      if (!wsServer) throw new Error("Daemon is not accepting agent messages");
      return wsServer.agentMessages;
    },
    callerIsActive: async (agentId) => {
      const record = await agentStorage.get(agentId);
      return record ? !record.archivedAt : Boolean(agentManager.getAgent(agentId));
    },
    ...createFinishObservation({
      agentManager,
      agentStorage,
      waitForResume: restartRecovery.waitForResume,
      serverId,
      logger,
      messages: () => {
        if (!wsServer) throw new Error("Daemon is not accepting agent messages");
        return wsServer.agentMessages;
      },
      hosts: () => {
        if (!wsServer) throw new Error("Daemon is not accepting host operations");
        return wsServer.toolHosts();
      },
    }),
  });

  const idleRuntimeCleanup = createIdleRuntimeCleanup({
    enabled: daemonConfigStore.get().idleRuntimeCleanup !== false,
    runtimes: () => agentManager.getRuntimeCleanupCandidates(),
    isProtected: (agentId) =>
      finishSubscriptions.hasPendingForCaller(agentId) ||
      (wsServer?.agentMessages.hasPending(agentId) ?? false),
    logger,
  });

  const unsubscribeIdleRuntimeCleanup = connectIdleRuntimeCleanupConfig(
    daemonConfigStore,
    idleRuntimeCleanup,
  );

  const projectMemory = new ProjectMemory(config.paseoHome);
  const handlePimiMemory = createPimiMemoryHandler({
    memory: projectMemory,
    projects: projectRegistry,
    reportError: (error) => logger.error({ err: error }, "Pimi memory request failed"),
  });
  app.post(PIMI_MEMORY_ROUTE, requireLocalPimi("Memory"), handlePimiMemory);
  const createAgentToolHostDependencies = (
    runtime: PaseoToolRuntimeContext,
    canUseCallerScopedTools = true,
  ): PaseoToolHostDependencies => ({
    finishSubscriptions: () => finishSubscriptions,
    agentMessages: () => {
      if (!wsServer) throw new Error("Daemon is not accepting agent messages");
      return wsServer.agentMessages;
    },
    serverId,
    hosts: () => {
      if (!wsServer) throw new Error("Daemon is not accepting host operations");
      return wsServer.toolHosts();
    },
    agentManager,
    agentStorage,
    terminalManager,
    getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
    automationService,
    heartbeatService,
    attackService,
    providerSnapshotManager,
    daemonConfigStore,
    github,
    workspaceGitService,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    workspaceRegistry,
    projectRegistry,
    projectMemory: canUseCallerScopedTools ? projectMemory : undefined,
    pimiSpaces: canUseCallerScopedTools ? pimiSpaces : undefined,
    searchCodebase: canUseCallerScopedTools ? searchPimiCodebase : undefined,
    pimiTaskHome: canUseCallerScopedTools ? config.paseoHome : undefined,
    createDirectoryWorkspace: async (cwd, title, projectId, context) => {
      const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
        cwd,
        title,
        projectId,
        context,
      );
      await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
      return workspace;
    },
    workspaceScripts: createWorkspaceScriptsService({
      serviceProxy,
      scriptRuntimeStore,
      terminalManager,
      workspaceRegistry,
      projectRegistry,
      workspaceRuntimeStore,
      getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
      serviceProxyPublicBaseUrl,
      resolveScriptHealth: (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
      logger,
      emit: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
      publishStatusUpdate: (message) => wsServer?.publishScriptStatusUpdate(message),
      spawnWorkspaceScript,
      assertAutomationAllowed: (workspaceId) =>
        assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, workspaceId),
      getGlobalServicePorts: () => daemonConfigStore.readServicePorts(),
    }),
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    ensureWorkspaceForCreate: createAgentCommandDependencies.ensureWorkspaceForCreate,
    createPaseoWorktree: createAgentCommandDependencies.createPaseoWorktree,
    browserToolsEnabled: browserToolsPolicy.isEnabled(),
    browserToolsBroker,
    paseoToolPolicy:
      runtime.paseoToolPolicy ??
      (runtime.callerAgentId ? agentManager.getPaseoToolPolicy(runtime.callerAgentId) : undefined),
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    callerAgentId: runtime.callerAgentId,
    enableVoiceTools: runtime.enableVoiceTools,
    voiceOnly: runtime.voiceOnly,
    resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
    resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
    logger,
  });
  const createAgentToolCatalog = (runtime: PaseoToolRuntimeContext) =>
    createPaseoToolCatalog(createAgentToolHostDependencies(runtime));
  const setAgentProviderToolsEnabled = (enabled: boolean) => {
    agentProviderRuntime.setPaseoToolCatalog(
      enabled ? createPaseoAgentToolManifest(createAgentToolHostDependencies({})) : null,
    );
  };
  agentManager.setPaseoToolCatalogFactory(createAgentToolCatalog);
  agentManager.setPaseoToolsEnabled(config.mcpInjectIntoAgents !== false);
  setAgentProviderToolsEnabled(config.mcpEnabled !== false && config.mcpInjectIntoAgents !== false);

  let mcpEnabled = config.mcpEnabled ?? true;
  let agentMcpBaseUrl: string | null = null;
  {
    const agentMcpRoute = "/mcp/agents";

    const createAgentMcpSession = async (
      callerAgentId: string | undefined,
      boundCaller: boolean,
    ) => {
      const agentMcpServer = await createAgentMcpServer(
        createAgentToolHostDependencies(
          {
            callerAgentId,
            paseoToolPolicy: callerAgentId
              ? agentManager.getPaseoToolPolicy(callerAgentId)
              : undefined,
          },
          boundCaller && daemonConfigStore.get().mcp.injectIntoAgents !== false,
        ),
        { lazyTools: callerAgentId ? agentManager.agentUsesPimiToolLoader(callerAgentId) : false },
      );

      // Stateless mode: each HTTP request builds a fresh server + transport that is
      // torn down when the response closes, so no per-session state is retained between
      // requests. The agent control plane only lists and calls tools, neither of which
      // needs cross-request state, so sessions would only pin memory for the life of the
      // daemon (agents that exit without a clean DELETE never get reaped).
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
        // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
        enableDnsRebindingProtection: false,
      });
      Object.assign(transport, {
        onerror: (err: Error) => {
          // COMPAT(claude-code >= 2.1.322): it sends MCP-Protocol-Version 2026-07-28, which
          // @modelcontextprotocol/sdk 1.32.2 rejects with a 400 before Claude Code falls back
          // to a supported version. Tools keep working, so this is not an error.
          if (err.message.startsWith("Bad Request: Unsupported protocol version")) {
            logger.warn(
              { reason: err.message },
              "Agent MCP client offered an unsupported protocol version",
            );
            return;
          }
          logger.error({ err }, "Agent MCP transport error");
        },
      });

      await agentMcpServer.connect(transport);
      return { server: agentMcpServer, transport };
    };

    const runAgentMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      if (!mcpEnabled) {
        res.status(404).json({ error: "Agent MCP endpoint disabled" });
        return;
      }
      const callerAgentIdRaw = req.query.callerAgentId;
      const callerAgentIdValue = Array.isArray(callerAgentIdRaw)
        ? callerAgentIdRaw[0]
        : callerAgentIdRaw;
      const callerAgentId = typeof callerAgentIdValue === "string" ? callerAgentIdValue : undefined;
      const authorizationHeader = req.header("authorization");
      const bearer = extractHttpBearerToken(authorizationHeader);
      // General tools also serve legacy/password clients. Private Pimi tools require a credential
      // bound to the injected caller, including on daemons with no password.
      const boundCaller = Boolean(
        callerAgentId &&
        bearer &&
        matchesLocalCredential(agentMcpTokenForCaller(callerAgentId), bearer),
      );
      // This route is exempt from the global daemon-password middleware, so it
      // authenticates here using the injected capability token (or a valid
      // daemon password). Without this, a password-protected daemon would be
      // wide open on its agent control plane.
      if (
        !boundCaller &&
        !(await isAgentMcpRequestAuthorized({
          password: config.auth?.password,
          capabilityToken: agentMcpAuthToken,
          authorizationHeader,
        }))
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (config.mcpDebug) {
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            sessionId: req.header("mcp-session-id"),
            authorization: req.header("authorization") ? MCP_DEBUG_SECRET : undefined,
            body: describeMcpDebugPayload(req.body),
          },
          "Agent MCP request",
        );
      }
      try {
        // Stateless: GET (standalone SSE) and DELETE (session termination) have no
        // meaning without sessions. The MCP client tolerates 405 on the GET stream
        // and never issues a DELETE because it is never handed a session id.
        if (req.method !== "POST") {
          res.status(405).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed",
            },
            id: null,
          });
          return;
        }
        const { server, transport } = await createAgentMcpSession(callerAgentId, boundCaller);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger.error({ err }, "Failed to handle Agent MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error",
            },
            id: null,
          });
        }
      }
    };

    const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
      void runAgentMcpRequest(req, res);
    };

    app.post(agentMcpRoute, handleAgentMcpRequest);
    app.get(agentMcpRoute, handleAgentMcpRequest);
    app.delete(agentMcpRoute, handleAgentMcpRequest);
    logger.info({ route: agentMcpRoute, enabled: mcpEnabled }, "Agent MCP route mounted");
  }

  logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

  const start = async () => {
    let mainStarted = false;
    try {
      localCredential = await writeLocalCredential(config.paseoHome);
      if (serviceProxyListenTarget) {
        const boundServiceProxyTarget = await serviceProxy.startStandalone({
          listenTarget: serviceProxyListenTarget,
        });
        serviceProxyListenTarget = boundServiceProxyTarget;
        logger.info(
          {
            listen: formatListenTarget(serviceProxyListenTarget),
            publicBaseUrl: serviceProxyPublicBaseUrl,
            elapsed: elapsed(),
          },
          "Service proxy listening",
        );
      }

      // Start main HTTP server
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          mainStarted = true;
          const logAndResolve = async () => {
            boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
            const mcpBaseUrl = createAgentMcpBaseUrl(boundListenTarget);
            agentMcpBaseUrl =
              !mcpEnabled || config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
            agentManager.setMcpBaseUrl(agentMcpBaseUrl);
            agentManager.setPaseoToolsEnabled(mcpEnabled && config.mcpInjectIntoAgents !== false);
            daemonConfigStore.onFieldChange("mcp.enabled", (value) => {
              mcpEnabled = value !== false;
              const inject = daemonConfigStore.get().mcp.injectIntoAgents !== false;
              agentManager.setMcpBaseUrl(mcpEnabled && inject ? mcpBaseUrl : null);
              agentManager.setPaseoToolsEnabled(mcpEnabled && inject);
              setAgentProviderToolsEnabled(mcpEnabled && inject);
            });
            daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
              agentManager.setMcpBaseUrl(mcpEnabled && value ? mcpBaseUrl : null);
              agentManager.setPaseoToolsEnabled(mcpEnabled && value !== false);
              setAgentProviderToolsEnabled(mcpEnabled && value !== false);
            });
            daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
              agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
            });
            const relayUseTls =
              config.relayUseTls ??
              (relayEndpoint !== undefined && shouldUseTlsForDefaultHostedRelay(relayEndpoint));
            const relayConfig = relayEndpoint
              ? {
                  enabled: daemonConfigStore.get().relay?.enabled === true,
                  endpoint: relayEndpoint,
                  publicEndpoint: config.relayPublicEndpoint ?? relayEndpoint,
                  useTls: relayUseTls,
                  publicUseTls: config.relayPublicUseTls ?? relayUseTls,
                }
              : null;
            if (boundListenTarget.type === "tcp") {
              logger.info(
                {
                  host: boundListenTarget.host,
                  port: boundListenTarget.port,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
              );
            } else {
              logger.info(
                {
                  path: boundListenTarget.path,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on ${boundListenTarget.path}`,
              );
            }
            if (config.auth?.password) {
              logger.info("Daemon password authentication enabled");
            }

            wsServer = new VoiceAssistantWebSocketServer(
              httpServer,
              logger,
              serverId,
              agentManager,
              agentStorage,
              downloadTokenStore,
              config.paseoHome,
              daemonConfigStore,
              mcpBaseUrl,
              {
                getAllowedOrigins: () => allowedOrigins,
                getHostnames: () => configuredHostnames,
                startPaused: true,
              },
              workspaceAutoName,
              workspaceRuntimeStore,
              daemonAuth,
              speechService,
              terminalManager,
              {
                finalTimeoutMs: config.dictationFinalTimeoutMs,
              },
              daemonVersion,
              (intent) => {
                try {
                  config.onLifecycleIntent?.(intent);
                } catch (error) {
                  logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
                }
              },
              projectRegistry,
              workspaceRegistry,
              { automationService, heartbeatService, attackService },
              checkoutDiffManager,
              serviceProxy,
              scriptRuntimeStore,
              handleBranchChange,
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
              (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
              workspaceGitService,
              github,
              config.pushNotificationSender,
              providerSnapshotManager,
              {
                listen: formatListenTarget(boundListenTarget ?? listenTarget),
                worktreesRoot: config.worktreesRoot,
                get appBaseUrl() {
                  return appBaseUrl;
                },
                desktopManaged: config.desktopManaged === true,
                getRelayConfig: () => {
                  const current = relayRuntime?.getConfig() ?? relayConfig;
                  return (
                    current && {
                      ...current,
                      requireProtectedSecurity:
                        daemonConfigStore.get().relay?.requireProtectedSecurity === true,
                    }
                  );
                },
              },
              serviceProxyPublicBaseUrl,
              browserToolsBroker,
              workspaceSetupRuntime,
              pluginRuntime,
              orchestrationSkills,
              workspaceLabelService,
              finishSubscriptions,
            );
            pluginRuntime.bindPaseoSessionHost(wsServer);
            await pluginRuntime.start();
            providerSnapshotManager.settlePluginProviders();
            restartRecovery.resumePending();
            await finishSubscriptions.start();
            wsServer.beginAcceptingConnections();
            const relaySecurityLogger = logger.child({ module: "relay-security" });
            if (relayConfig)
              relayRuntime = createRelayRuntime({
                config: relayConfig,
                logger,
                attachSocket: (ws, metadata) =>
                  admitSecuredRelaySocket(
                    ws,
                    {
                      daemonKeyPair: daemonKeyPair.keyPair,
                      logger: relaySecurityLogger,
                      requireProtectedMode: () =>
                        daemonConfigStore.get().relay?.requireProtectedSecurity === true,
                    },
                    async (secured) => {
                      if (!wsServer) throw new Error("WebSocket server is not ready");
                      await wsServer.attachExternalSocket(secured.socket, {
                        ...metadata,
                        transport: "relay",
                        securityMode: secured.securityMode,
                      });
                    },
                  ),
                serverId,
              });
            daemonConfigStore.onFieldChange("relay.enabled", (value) => {
              relayRuntime?.setEnabled(value === true);
            });
          };

          logAndResolve().then(resolve, reject);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);

        if (listenTarget.type === "tcp") {
          httpServer.listen(listenTarget.port, listenTarget.host);
        } else {
          if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
            unlinkSync(listenTarget.path);
          }
          httpServer.listen(listenTarget.path);
        }
      });

      // Start speech service after listening so synchronous Sherpa native
      // model loading doesn't block the server from accepting connections.
      speechService.start();
      scriptHealthMonitor.start();
    } catch (error) {
      localCredential = null;
      await deleteLocalCredential(config.paseoHome);
      unsubscribePluginProviders();
      unsubscribePluginSessionChanges();
      await pluginRuntime.stopAllPlugins().catch(() => undefined);
      await serviceProxy.stopStandalone().catch(() => undefined);
      await agentProviderRuntime.shutdown().catch(() => undefined);
      if (mainStarted) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      throw error;
    }
  };

  const stop = async (options?: { keepTerminals?: boolean }) => {
    const keepTerminals = options?.keepTerminals === true;
    let terminalShutdownError: unknown = null;
    localCredential = null;
    await localNetworkPairing.close();
    await deleteLocalCredential(config.paseoHome);
    // Stop tracking plugin provider registrations before anything tears plugins
    // down, so plugin shutdown cannot withdraw a provider from under an agent
    // that is still open. Plugins themselves are stopped once every session
    // they serve has been closed, further down.
    unsubscribePluginProviders();
    unsubscribePluginSessionChanges();
    workspaceReconciliation.dispose();
    closeAllCodeNavigation();
    scriptHealthMonitor.stop();
    unsubscribeIdleRuntimeCleanup();
    await idleRuntimeCleanup.close();
    // Freeze both ingress and registration before taking the agent closure snapshot.
    wsServer?.prepareForShutdown();
    await finishSubscriptions.close();
    await wsServer?.agentMessages.close();
    agentManager.prepareForShutdown();
    await restartRecovery.captureRunningAgents();
    await closeAllAgents(logger, agentManager);
    await withTimeout({
      promise: pluginRuntime.drainEvents(),
      timeoutMs: AGENT_CLOSE_TIMEOUT_MS,
      label: "drain plugin lifecycle events",
    }).catch((error) => logger.warn({ err: error }, "Plugin lifecycle events did not finish"));
    await agentManager.flushForShutdown().catch(() => undefined);
    detachAgentStoragePersistence();
    await agentStorage.flush().catch(() => undefined);
    await agentProviderRuntime.shutdown();
    await pluginRuntime.stopAllPlugins();
    try {
      if (keepTerminals) {
        await terminalManager.detach();
        logger.info("Terminals left running for the next daemon");
      } else {
        await terminalManager.closeTerminals();
      }
    } catch (error) {
      // Finish the rest of the shutdown, then report it: the supervisor and `daemon stop`
      // retry the cleanup from the record the reaper kept.
      terminalShutdownError = error;
      logger.error({ err: error }, "Terminal shutdown failed");
    }
    await speechService.stop();
    await automationService.stop().catch(() => undefined);
    await heartbeatService.stop().catch(() => undefined);
    await attackService.stop().catch(() => undefined);
    await relayRuntime?.stop().catch(() => undefined);
    if (wsServer) {
      await wsServer.close();
    }
    await serviceProxy.stopStandalone();
    await networkLog.close();
    // Force-drop remaining sockets so httpServer.close() resolves promptly.
    // We've already closed wsServer (which sent ws-layer close frames) and
    // stopped every other service, so anything still attached is a TCP
    // socket whose higher-level shutdown hasn't fully released it (e.g.
    // upgraded WS sockets in the closing handshake, or HTTP keep-alive
    // sockets in CLOSE_WAIT). closeIdleConnections() does not catch
    // upgraded sockets, so we use closeAllConnections() here.
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
    if (terminalShutdownError) {
      throw terminalShutdownError;
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    serviceProxy,
    scriptRuntimeStore,
    browserToolsBroker,
    start,
    stop,
    getListenTarget: () => boundListenTarget,
    getServerId: () => serverId,
  };
}

/**
 * Closing an agent asks its provider to close the session and waits for the
 * answer. A provider that never answers must not hold the daemon open, so a
 * close that outlives this deadline is abandoned; `agentProviderRuntime`
 * shutdown runs next and rejects the request that was still pending.
 */
const AGENT_CLOSE_TIMEOUT_MS = 5_000;

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents({ includeInternal: true });
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await withTimeout({
          promise: agentManager.closeAgent(agent.id),
          timeoutMs: AGENT_CLOSE_TIMEOUT_MS,
          label: `close agent ${agent.id}`,
        });
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}

export function connectIdleRuntimeCleanupConfig(
  store: DaemonConfigStore,
  cleanup: Pick<ReturnType<typeof createIdleRuntimeCleanup>, "setEnabled">,
): () => void {
  cleanup.setEnabled(store.get().idleRuntimeCleanup !== false);
  return store.onFieldChange("idleRuntimeCleanup", (value) => cleanup.setEnabled(value !== false));
}
