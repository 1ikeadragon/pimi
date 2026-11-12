import { configurationEnvironment } from "./config-environment.js";
import path from "node:path";
import { resolvePimiNodeEnv } from "./pimi-env.js";
import { z } from "zod";
import { expandTilde } from "../utils/path.js";

import type { PimiDaemonConfig } from "./bootstrap.js";
import {
  loadPersistedConfig,
  LogFormatSchema,
  LogLevelSchema,
  type PersistedConfig,
} from "./persisted-config.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import { AgentProviderSchema } from "@pimi/protocol/provider-manifest";
import { shouldUseTlsForDefaultHostedRelay } from "@pimi/protocol/daemon-endpoints";
import { hashDaemonPassword } from "./auth.js";
import { resolveSpeechConfig } from "./speech/speech-config-resolver.js";
import { readSpeechSettings } from "./speech/speech-settings.js";
import { mergeHostnames, parseHostnamesEnv, type HostnamesConfig } from "./hostnames.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { DEFAULT_PAIRING_APP_BASE_URL } from "./connection-offer.js";
import { NETWORK_LOG_RETENTION_DAYS_DEFAULT } from "@pimi/protocol/messages";

export {
  loadPersistedConfig,
  readPersistedConfig,
  savePersistedConfig,
  getPersistedConfigValue,
  editPersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";

const DEFAULT_PORT = 6767;
const DEFAULT_TRUSTED_PROXIES = ["loopback"];

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function normalizeLogEnv(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.trim().toLowerCase();
}

function resolveGitProcessConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): NonNullable<PimiDaemonConfig["git"]> {
  return resolveGitProcessPolicy({
    env,
    persisted: persisted.daemon?.git,
  });
}

export type CliConfigOverrides = Partial<{
  listen: string;
  relayEnabled: boolean;
  relayUseTls: boolean;
  mcpEnabled: boolean;
  mcpInjectIntoAgents: boolean;
  hostnames: HostnamesConfig;
}>;

type TrustedProxiesConfig = true | string[];

function resolveLogConfigFromEnv(
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig,
): PersistedConfig["log"] {
  const level = parseLogLevelEnv(env.PIMI_LOG_LEVEL ?? env.PIMI_LOG);
  const format = parseLogFormatEnv(env.PIMI_LOG_FORMAT);
  const console = resolveConsoleLogConfigFromEnv(env, persisted.log?.console);
  const file = resolveFileLogConfigFromEnv(env, persisted.log?.file);

  if (level === undefined && format === undefined && !console && !file) {
    return persisted.log;
  }

  return {
    ...persisted.log,
    ...(level !== undefined ? { level } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(console ? { console } : {}),
    ...(file ? { file } : {}),
  };
}

function resolveConsoleLogConfigFromEnv(
  env: NodeJS.ProcessEnv,
  persisted: NonNullable<PersistedConfig["log"]>["console"],
): NonNullable<PersistedConfig["log"]>["console"] {
  const level = parseLogLevelEnv(env.PIMI_LOG_CONSOLE_LEVEL);
  const format = parseLogFormatEnv(env.PIMI_LOG_CONSOLE_FORMAT);
  if (level === undefined && format === undefined) return undefined;
  return {
    ...persisted,
    ...(level !== undefined ? { level } : {}),
    ...(format !== undefined ? { format } : {}),
  };
}

function resolveFileLogConfigFromEnv(
  env: NodeJS.ProcessEnv,
  persisted: NonNullable<PersistedConfig["log"]>["file"],
): NonNullable<PersistedConfig["log"]>["file"] {
  const level = parseLogLevelEnv(env.PIMI_LOG_FILE_LEVEL);
  const filePath = nonEmptyEnv(env.PIMI_LOG_FILE_PATH);
  const maxSize = nonEmptyEnv(env.PIMI_LOG_FILE_ROTATE_SIZE);
  const maxFiles = parsePositiveIntegerEnv(env.PIMI_LOG_FILE_ROTATE_COUNT);
  const hasRotateOverride = maxSize !== undefined || maxFiles !== undefined;
  if (level === undefined && filePath === undefined && !hasRotateOverride) return undefined;
  return {
    ...persisted,
    ...(level !== undefined ? { level } : {}),
    ...(filePath !== undefined ? { path: filePath } : {}),
    ...(hasRotateOverride
      ? {
          rotate: {
            ...persisted?.rotate,
            ...(maxSize !== undefined ? { maxSize } : {}),
            ...(maxFiles !== undefined ? { maxFiles } : {}),
          },
        }
      : {}),
  };
}

function parseLogLevelEnv(value: string | undefined): z.infer<typeof LogLevelSchema> | undefined {
  const parsed = LogLevelSchema.safeParse(normalizeLogEnv(value));
  return parsed.success ? parsed.data : undefined;
}

function parseLogFormatEnv(value: string | undefined): z.infer<typeof LogFormatSchema> | undefined {
  const parsed = LogFormatSchema.safeParse(normalizeLogEnv(value));
  return parsed.success ? parsed.data : undefined;
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const OptionalVoiceLlmProviderSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value): string | null =>
    typeof value === "string" ? value.trim().toLowerCase() : null,
  )
  .pipe(z.union([AgentProviderSchema, z.null()]));

function parseOptionalVoiceLlmProvider(value: unknown): AgentProvider | null {
  const parsed = OptionalVoiceLlmProviderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractProviderOverrides(
  providers: Record<string, unknown> | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!providers) {
    return undefined;
  }

  const providerOverrides = Object.entries(providers).flatMap(([providerId, provider]) => {
    const parsed = ProviderOverrideSchema.safeParse(provider);
    return parsed.success ? [[providerId, parsed.data] as const] : [];
  });

  return providerOverrides.length > 0 ? Object.fromEntries(providerOverrides) : undefined;
}

function extractAgentProviderSettings(
  providerOverrides: Record<string, ProviderOverride> | undefined,
): AgentProviderRuntimeSettingsMap | undefined {
  if (!providerOverrides) {
    return undefined;
  }

  const runtimeSettings = Object.entries(providerOverrides).flatMap(([providerId, provider]) => {
    const parsedProviderId = AgentProviderSchema.safeParse(providerId);
    if (!parsedProviderId.success || (!provider.command && !provider.env)) {
      return [];
    }

    return [
      [
        parsedProviderId.data,
        {
          command: provider.command
            ? {
                mode: "replace" as const,
                argv: provider.command,
              }
            : undefined,
          env: provider.env,
        },
      ] as const,
    ];
  });

  return runtimeSettings.length > 0
    ? (Object.fromEntries(runtimeSettings) as AgentProviderRuntimeSettingsMap)
    : undefined;
}

interface ResolveRelayInput {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
  cliRelayEnabled: boolean | undefined;
  cliRelayUseTls: boolean | undefined;
}

interface ResolvedRelay {
  enabled: boolean;
  enabledMutable: boolean;
  requireProtectedSecurity: boolean;
  endpoint: string | undefined;
  publicEndpoint: string | undefined;
  useTls: boolean;
  publicUseTls: boolean;
}

interface ResolvedServiceProxy {
  publicBaseUrl: string | null;
  standaloneListen: string | null;
}

function resolveTlsFromEnv(
  envValue: string | undefined,
  persistedValue: boolean | undefined,
  fallback: boolean,
): boolean {
  if (envValue !== undefined) {
    return parseBooleanEnv(envValue) ?? false;
  }
  return persistedValue ?? fallback;
}

// The project's self-hosted relay (docs/self-hosted-relay.md). Relay stays off until enabled.
const DEFAULT_RELAY_ENDPOINT = "relay.stateless.computer:443";

function resolveRelayEndpoints(input: ResolveRelayInput): {
  endpoint: string | undefined;
  publicEndpoint: string | undefined;
} {
  const endpoint =
    (input.env.PIMI_RELAY_ENDPOINT ?? input.persisted.daemon?.relay?.endpoint)?.trim() ||
    DEFAULT_RELAY_ENDPOINT;
  const publicEndpoint =
    (
      input.env.PIMI_RELAY_PUBLIC_ENDPOINT ?? input.persisted.daemon?.relay?.publicEndpoint
    )?.trim() || endpoint;
  return { endpoint, publicEndpoint };
}

function resolveRelayConfig(input: ResolveRelayInput): ResolvedRelay {
  const environmentEnabled = parseBooleanEnv(input.env.PIMI_RELAY_ENABLED);
  const { endpoint, publicEndpoint } = resolveRelayEndpoints(input);
  const enabled =
    endpoint !== undefined &&
    (input.cliRelayEnabled ??
      environmentEnabled ??
      input.persisted.daemon?.relay?.enabled ??
      false);
  const useTls =
    input.cliRelayUseTls ??
    resolveTlsFromEnv(
      input.env.PIMI_RELAY_USE_TLS,
      input.persisted.daemon?.relay?.useTls,
      endpoint !== undefined && shouldUseTlsForDefaultHostedRelay(endpoint),
    );
  const publicUseTls = resolveTlsFromEnv(
    input.env.PIMI_RELAY_PUBLIC_USE_TLS,
    input.persisted.daemon?.relay?.publicUseTls,
    useTls,
  );
  return {
    enabled,
    enabledMutable: input.cliRelayEnabled === undefined && environmentEnabled === undefined,
    requireProtectedSecurity: input.persisted.daemon?.relay?.requireProtectedSecurity ?? true,
    endpoint,
    publicEndpoint,
    useTls,
    publicUseTls,
  };
}

interface ResolvedVoiceLlm {
  provider: AgentProvider | null;
  providerExplicit: boolean;
  model: string | null;
}

function resolveServiceProxyPublicBaseUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid PIMI_SERVICE_PROXY_PUBLIC_BASE_URL: ${value}`);
  }
}

function resolveServiceProxyConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): ResolvedServiceProxy {
  const enabledShim =
    parseBooleanEnv(env.PIMI_SERVICE_PROXY_ENABLED) ?? persisted.daemon?.serviceProxy?.enabled;
  // COMPAT(serviceProxyEnabled): added 2026-06-02, remove after 2026-12-02.
  // `enabled=false` used to disable the separate service proxy listener. Localhost
  // service proxying is now always enabled; this only suppresses optional layers.
  const optionalLayersEnabled = enabledShim !== false;
  const publicBaseUrl = optionalLayersEnabled
    ? resolveServiceProxyPublicBaseUrl(
        env.PIMI_SERVICE_PROXY_PUBLIC_BASE_URL ??
          persisted.daemon?.serviceProxy?.publicBaseUrl ??
          null,
      )
    : null;
  const standaloneListen = optionalLayersEnabled
    ? (env.PIMI_SERVICE_PROXY_LISTEN ?? persisted.daemon?.serviceProxy?.listen ?? null)
    : null;

  return { publicBaseUrl, standaloneListen };
}

function resolveVoiceLlmConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): ResolvedVoiceLlm {
  const envVoiceLlmProvider = parseOptionalVoiceLlmProvider(env.PIMI_VOICE_LLM_PROVIDER);
  const persistedVoiceLlmProvider = parseOptionalVoiceLlmProvider(
    persisted.features?.voiceMode?.llm?.provider,
  );
  return {
    provider: envVoiceLlmProvider ?? persistedVoiceLlmProvider ?? null,
    providerExplicit: envVoiceLlmProvider !== null || persistedVoiceLlmProvider !== null,
    model: persisted.features?.voiceMode?.llm?.model ?? null,
  };
}

function resolveCorsAllowedOrigins(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string[] {
  const envCorsOrigins = env.PIMI_CORS_ORIGINS
    ? env.PIMI_CORS_ORIGINS.split(",").map((s) => s.trim())
    : [];
  const persistedCorsOrigins = persisted.daemon?.cors?.allowedOrigins ?? [];
  return Array.from(
    new Set([...persistedCorsOrigins, ...envCorsOrigins].filter((s) => s.length > 0)),
  );
}

function parseTrustedProxiesEnv(value: string | undefined): TrustedProxiesConfig | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return [];
  }

  return trimmed
    .split(",")
    .map((proxy) => proxy.trim())
    .filter((proxy) => proxy.length > 0);
}

function resolveTrustedProxiesConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): TrustedProxiesConfig {
  return (
    parseTrustedProxiesEnv(env.PIMI_TRUSTED_PROXIES) ??
    persisted.daemon?.trustedProxies ??
    DEFAULT_TRUSTED_PROXIES
  );
}

// PIMI_LISTEN can be:
// - host:port (TCP)
// - /path/to/socket (Unix socket)
// - unix:///path/to/socket (Unix socket)
// Default is TCP at 127.0.0.1:6767
function resolveListenAddress(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string {
  return (
    cli?.listen ??
    env.PIMI_LISTEN ??
    persisted.daemon?.listen ??
    `127.0.0.1:${env.PORT ?? DEFAULT_PORT}`
  );
}

function resolveAuthConfig(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): PimiDaemonConfig["auth"] {
  const envPassword = env.PIMI_PASSWORD?.trim();
  if (envPassword) {
    return { password: hashDaemonPassword(envPassword) };
  }
  return persisted.daemon?.auth?.password
    ? { password: persisted.daemon.auth.password }
    : undefined;
}

function resolveWorktreesRoot(
  pimiHome: string,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string | undefined {
  const configuredRoot = persisted.worktrees?.root?.trim();
  if (!configuredRoot) {
    return undefined;
  }

  const expandedRoot = expandTilde(configuredRoot);
  return path.isAbsolute(expandedRoot)
    ? path.resolve(expandedRoot)
    : path.resolve(pimiHome, expandedRoot);
}

function resolveAppendSystemPrompt(persisted: ReturnType<typeof loadPersistedConfig>): string {
  return persisted.daemon?.appendSystemPrompt ?? "";
}

function resolveNetworkLogConfig(persisted: ReturnType<typeof loadPersistedConfig>) {
  return {
    logNetworkEnabled: persisted.log?.network?.enabled ?? true,
    logNetworkRetentionDays:
      persisted.log?.network?.retentionDays ?? NETWORK_LOG_RETENTION_DAYS_DEFAULT,
  };
}

function resolveUsageEnabled(persisted: ReturnType<typeof loadPersistedConfig>): boolean {
  return persisted.daemon?.usage?.enabled === true;
}

function resolvePairingAppBaseUrl(
  env: NodeJS.ProcessEnv,
  persisted: ReturnType<typeof loadPersistedConfig>,
): string {
  if (env.PIMI_APP_BASE_URL !== undefined) return env.PIMI_APP_BASE_URL;
  const persistedUrl = persisted.app?.baseUrl;
  return persistedUrl ?? DEFAULT_PAIRING_APP_BASE_URL;
}

function resolveBrowserToolsEnabled(persisted: ReturnType<typeof loadPersistedConfig>): boolean {
  return persisted.daemon?.browserTools?.enabled ?? false;
}

/**
 * Both profile lists stay `undefined` when absent rather than defaulting to an
 * empty array: for terminal profiles that is what selects the built-in
 * defaults, so an empty array has to keep meaning "the user removed them all".
 */
function resolveProfileLists(persisted: ReturnType<typeof loadPersistedConfig>) {
  return {
    terminalProfiles: persisted.daemon?.terminalProfiles,
    editorLanguageServers: persisted.daemon?.editorLanguageServers,
    agentProfiles: persisted.daemon?.agentProfiles,
    agentProfilesRemovedBuiltins: persisted.daemon?.agentProfilesRemovedBuiltins,
  };
}

function resolveStaticLoadConfigSettings(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: ReturnType<typeof loadPersistedConfig>,
) {
  return {
    mcpEnabled: cli?.mcpEnabled ?? persisted.daemon?.mcp?.enabled ?? true,
    // On unless the user switched it off: delegation, shared memory, and tasks all go through
    // these tools, and the app's settings show an unset value as on.
    mcpInjectIntoAgents:
      cli?.mcpInjectIntoAgents ?? persisted.daemon?.mcp?.injectIntoAgents ?? true,
    usageEnabled: resolveUsageEnabled(persisted),
    browserToolsEnabled: resolveBrowserToolsEnabled(persisted),
    autoArchiveAfterMerge: persisted.daemon?.autoArchiveAfterMerge ?? false,
    ...resolveNetworkLogConfig(persisted),
    appendSystemPrompt: resolveAppendSystemPrompt(persisted),
    ...resolveProfileLists(persisted),
    hostnames: mergeHostnames([
      persisted.daemon?.hostnames,
      parseHostnamesEnv(env.PIMI_HOSTNAMES ?? env.PIMI_ALLOWED_HOSTS),
      cli?.hostnames,
    ]),
    trustedProxies: resolveTrustedProxiesConfig(env, persisted),
    appBaseUrl: resolvePairingAppBaseUrl(env, persisted),
  };
}

interface ResolveConfigFromPersistedOptions {
  env?: NodeJS.ProcessEnv;
  cli?: CliConfigOverrides;
}

// Startup values, including authentication, never enter runtime settings resolution.
export type ResolvedDaemonSettings = Pick<
  PimiDaemonConfig,
  | "corsAllowedOrigins"
  | "hostnames"
  | "trustedProxies"
  | "mcpEnabled"
  | "mcpInjectIntoAgents"
  | "usageEnabled"
  | "browserToolsEnabled"
  | "git"
  | "autoArchiveAfterMerge"
  | "logNetworkEnabled"
  | "logNetworkRetentionDays"
  | "enableTerminalAgentHooks"
  | "appendSystemPrompt"
  | "terminalProfiles"
  | "editorLanguageServers"
  | "agentProfiles"
  | "agentProfilesRemovedBuiltins"
  | "skillSelection"
  | "pluginsEnabled"
  | "plugins"
  | "relayEnabled"
  | "relayRequireProtectedSecurity"
  | "appBaseUrl"
  | "idleRuntimeCleanup"
  | "resumeOnStartup"
  | "resumePrompt"
  | "providerCatalogRefreshTimeoutMs"
  | "metadataGeneration"
  | "providerOverrides"
>;

export function resolveConfigFromPersisted(
  pimiHome: string,
  persisted: PersistedConfig,
  options?: ResolveConfigFromPersistedOptions,
): PimiDaemonConfig {
  const env = configurationEnvironment(options?.env ?? process.env);
  const cli = options?.cli;
  const { overrideControlledPaths, ...settings } = resolveReloadableConfig(persisted, options);
  const relay = resolveRelayConfig({
    env,
    persisted,
    cliRelayEnabled: cli?.relayEnabled,
    cliRelayUseTls: cli?.relayUseTls,
  });
  const { openai, speech } = resolveSpeechConfig({ pimiHome, env, persisted });
  const voiceLlm = resolveVoiceLlmConfig(env, persisted);
  return {
    ...settings,
    listen: resolveListenAddress(env, cli, persisted),
    pimiHome,
    desktopManaged: env.PIMI_DESKTOP_MANAGED === "1",
    worktreesRoot: resolveWorktreesRoot(pimiHome, persisted),
    pluginRegistries: persisted.pluginRegistries,
    pluginRegistryUrl: env.PIMI_PLUGIN_REGISTRY,
    mcpDebug: env.MCP_DEBUG === "1",
    isDev: resolvePimiNodeEnv(env) === "development",
    agentStoragePath: path.join(pimiHome, "agents"),
    staticDir: "public",
    agentClients: {},
    relayEnabledMutable: relay.enabledMutable,
    relayEndpoint: relay.endpoint,
    relayPublicEndpoint: relay.publicEndpoint,
    relayUseTls: relay.useTls,
    relayPublicUseTls: relay.publicUseTls,
    serviceProxy: resolveServiceProxyConfig(env, persisted),
    auth: resolveAuthConfig(env, persisted),
    openai,
    speech,
    voiceLlmProvider: voiceLlm.provider,
    voiceLlmProviderExplicit: voiceLlm.providerExplicit,
    voiceLlmModel: voiceLlm.model,
    agentProviderSettings: extractAgentProviderSettings(settings.providerOverrides),
    log: resolveLogConfigFromEnv(env, persisted),
    configReload: {
      env: { ...env },
      cli: cli ? { ...cli } : undefined,
      overrideControlledPaths,
      startupPersisted: persisted,
    },
  };
}

export function resolveReloadableConfig(
  persisted: PersistedConfig,
  options?: ResolveConfigFromPersistedOptions,
): ResolvedDaemonSettings & { overrideControlledPaths: string[] } {
  const env = configurationEnvironment(options?.env ?? process.env);
  const cli = options?.cli;
  const relay = resolveRelayConfig({
    env,
    persisted,
    cliRelayEnabled: cli?.relayEnabled,
    cliRelayUseTls: cli?.relayUseTls,
  });
  return {
    ...resolveStaticLoadConfigSettings(env, cli, persisted),
    corsAllowedOrigins: resolveCorsAllowedOrigins(env, persisted),
    git: resolveGitProcessConfig(env, persisted),
    enableTerminalAgentHooks: persisted.daemon?.enableTerminalAgentHooks ?? false,
    skillSelection: persisted.agents?.skills?.selection,
    pluginsEnabled: persisted.pluginsEnabled ?? false,
    plugins: persisted.plugins,
    relayEnabled: relay.enabled,
    relayRequireProtectedSecurity: relay.requireProtectedSecurity,
    idleRuntimeCleanup: persisted.agents?.idleRuntimeCleanup ?? true,
    ...resolveRestartRecoveryConfig(persisted.agents),
    providerCatalogRefreshTimeoutMs: persisted.agents?.catalogRefreshTimeoutMs,
    metadataGeneration: persisted.agents?.metadataGeneration,
    providerOverrides: extractProviderOverrides(
      persisted.agents?.providers as Record<string, unknown> | undefined,
    ),
    overrideControlledPaths: resolveOverrideControlledPaths(env, cli, persisted),
  };
}

export function loadConfig(
  pimiHome: string,
  options?: ResolveConfigFromPersistedOptions,
): PimiDaemonConfig {
  const persisted = loadPersistedConfig(pimiHome);
  return resolveConfigFromPersisted(pimiHome, persisted, options);
}

function parsePositiveGitOverride(value: string | undefined): boolean {
  if (value === undefined) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function resolveOverrideControlledPaths(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
  persisted: PersistedConfig,
): string[] {
  return Array.from(
    new Set([
      ...resolveDaemonOverrideControlledPaths(env, cli),
      ...resolveLogOverrideControlledPaths(env),
      ...resolveSpeechOverrideControlledPaths(env, persisted),
    ]),
  ).sort();
}

function resolveDaemonOverrideControlledPaths(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
): string[] {
  return [
    ...resolveCoreDaemonOverridePaths(env, cli),
    ...resolveRelayOverridePaths(env, cli),
    ...resolveServiceOverridePaths(env),
  ];
}

function resolveCoreDaemonOverridePaths(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
): string[] {
  const paths: string[] = [];
  if (cli?.listen !== undefined || env.PIMI_LISTEN !== undefined) {
    paths.push("daemon.listen");
  }
  if (cli?.mcpEnabled !== undefined) paths.push("daemon.mcp.enabled");
  if (cli?.mcpInjectIntoAgents !== undefined) paths.push("daemon.mcp.injectIntoAgents");
  // Hostname sources append instead of replacing one another, so a launch value
  // does not prevent a persisted hostname edit from taking effect.
  if (parseTrustedProxiesEnv(env.PIMI_TRUSTED_PROXIES) !== undefined) {
    paths.push("daemon.trustedProxies");
  }
  if (parsePositiveGitOverride(env.PIMI_GIT_MAX_PROCESSES_PER_SECOND)) {
    paths.push("daemon.git.maxProcessesPerSecond");
  }
  if (parsePositiveGitOverride(env.PIMI_GIT_MAX_PROCESS_CONCURRENCY)) {
    paths.push("daemon.git.maxProcessConcurrency");
  }
  if (env.PIMI_APP_BASE_URL !== undefined) paths.push("app.baseUrl");
  if (env.PIMI_PASSWORD?.trim()) paths.push("daemon.auth.password");
  return paths;
}

function resolveRelayOverridePaths(
  env: NodeJS.ProcessEnv,
  cli: CliConfigOverrides | undefined,
): string[] {
  const paths: string[] = [];
  if (cli?.relayEnabled !== undefined || parseBooleanEnv(env.PIMI_RELAY_ENABLED) !== undefined) {
    paths.push("daemon.relay.enabled");
  }
  if (env.PIMI_RELAY_ENDPOINT !== undefined) paths.push("daemon.relay.endpoint");
  if (env.PIMI_RELAY_PUBLIC_ENDPOINT !== undefined) {
    paths.push("daemon.relay.publicEndpoint");
  }
  if (cli?.relayUseTls !== undefined || env.PIMI_RELAY_USE_TLS !== undefined) {
    paths.push("daemon.relay.useTls");
  }
  if (env.PIMI_RELAY_PUBLIC_USE_TLS !== undefined) {
    paths.push("daemon.relay.publicUseTls");
  }
  return paths;
}

function resolveServiceOverridePaths(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  const serviceProxyEnabled = parseBooleanEnv(env.PIMI_SERVICE_PROXY_ENABLED);
  if (serviceProxyEnabled !== undefined) paths.push("daemon.serviceProxy.enabled");
  if (env.PIMI_SERVICE_PROXY_LISTEN !== undefined || serviceProxyEnabled === false) {
    paths.push("daemon.serviceProxy.listen");
  }
  if (env.PIMI_SERVICE_PROXY_PUBLIC_BASE_URL !== undefined || serviceProxyEnabled === false) {
    paths.push("daemon.serviceProxy.publicBaseUrl");
  }
  return paths;
}

function resolveLogOverrideControlledPaths(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  if (parseLogLevelEnv(env.PIMI_LOG_LEVEL ?? env.PIMI_LOG) !== undefined) {
    paths.push("log.level");
  }
  if (parseLogFormatEnv(env.PIMI_LOG_FORMAT) !== undefined) paths.push("log.format");
  if (parseLogLevelEnv(env.PIMI_LOG_CONSOLE_LEVEL) !== undefined) {
    paths.push("log.console.level");
  }
  if (parseLogFormatEnv(env.PIMI_LOG_CONSOLE_FORMAT) !== undefined) {
    paths.push("log.console.format");
  }
  if (parseLogLevelEnv(env.PIMI_LOG_FILE_LEVEL) !== undefined) paths.push("log.file.level");
  if (nonEmptyEnv(env.PIMI_LOG_FILE_PATH) !== undefined) paths.push("log.file.path");
  if (nonEmptyEnv(env.PIMI_LOG_FILE_ROTATE_SIZE) !== undefined) {
    paths.push("log.file.rotate.maxSize");
  }
  if (parsePositiveIntegerEnv(env.PIMI_LOG_FILE_ROTATE_COUNT) !== undefined) {
    paths.push("log.file.rotate.maxFiles");
  }
  return paths;
}

function resolveSpeechOverrideControlledPaths(
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig,
): string[] {
  const paths = Object.keys(readSpeechSettings(persisted, env).envOverrides);
  if (env.PIMI_VOICE_LLM_PROVIDER !== undefined) paths.push("features.voiceMode.llm.provider");
  if (env.PIMI_LOCAL_MODELS_DIR !== undefined) paths.push("providers.local.modelsDir");
  return paths;
}

function resolveRestartRecoveryConfig(agents: PersistedConfig["agents"]) {
  return {
    resumeOnStartup: agents?.resumeOnStartup ?? false,
    resumePrompt: agents?.resumePrompt ?? "Resume working.",
  };
}
