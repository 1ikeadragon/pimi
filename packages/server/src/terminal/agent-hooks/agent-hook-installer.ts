import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writePrivateFileAtomicSync } from "../../server/private-files.js";

export interface AgentHookEventDefinition {
  event: string;
}

export type AgentHookActivityState = "running" | "idle" | "needs-input";

export interface AgentHookActivityInput {
  isTTY?: boolean;
  read(): Promise<string | null>;
}

export interface AgentHookProvider<TConfig = unknown> {
  id: string;
  events: AgentHookEventDefinition[];
  resolveActivity(input: {
    event: string;
    input: AgentHookActivityInput;
  }): Promise<AgentHookActivityState | null>;
  install: AgentHookInstallStrategy<TConfig>;
}

export type AgentHookInstallStrategy<TConfig> =
  | AgentHookConfigFileInstallStrategy<TConfig>
  | AgentHookPluginFileInstallStrategy;

interface AgentHookInstallStrategyBase {
  kind: "config-file" | "plugin-file";
  configDir: string;
  configDirBase?: "home" | "xdg-config";
  configFile: string;
  configDirEnvOverride?: string;
  hookMarker: string;
}

export interface AgentHookConfigFileInstallStrategy<TConfig> extends AgentHookInstallStrategyBase {
  kind: "config-file";
  format: AgentHookConfigFormat<TConfig>;
}

export interface AgentHookPluginFileInstallStrategy extends AgentHookInstallStrategyBase {
  kind: "plugin-file";
  source: string;
  legacySourceDigests?: readonly string[];
}

export interface AgentHookConfigFormat<TConfig> {
  empty(): TConfig;
  parse(raw: string): TConfig;
  stringify(config: TConfig): string;
  install(config: TConfig, provider: AgentHookProvider<TConfig>): TConfig;
  uninstall(config: TConfig, provider: AgentHookProvider<TConfig>): TConfig;
  installState(config: TConfig, provider: AgentHookProvider<TConfig>): AgentHookInstallState;
}

export type AgentHookInstallState = "installed" | "not-installed" | "partial";

export interface AgentHookInstallOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  configDir?: string;
}

export interface AgentHookInstallLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface AgentHookInstallResult {
  configPath: string;
  changed: boolean;
}

export function installAgentHooks<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): AgentHookInstallResult {
  if (provider.install.kind === "plugin-file") {
    return installAgentHookPluginFile(provider.install, options);
  }

  const format = provider.install.format;
  return updateAgentHookConfig(provider, options, (config) => format.install(config, provider));
}

export function uninstallAgentHooks<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): AgentHookInstallResult {
  if (provider.install.kind === "plugin-file") {
    return uninstallAgentHookPluginFile(provider.install, options);
  }

  const format = provider.install.format;
  return updateAgentHookConfig(provider, options, (config) =>
    format.installState(config, provider) === "not-installed"
      ? config
      : format.uninstall(config, provider),
  );
}

export function agentHooksAreInstalled<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): boolean {
  return getAgentHookInstallState(provider, options) === "installed";
}

export function getAgentHookInstallState<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): AgentHookInstallState {
  const configPath = resolveAgentHookConfigPath(provider, options);
  const raw = readHookConfig(configPath);
  if (raw === null) return "not-installed";

  const { install } = provider;
  if (install.kind === "plugin-file") {
    const source = normalizeRawConfig(raw);
    if (source === normalizeRawConfig(install.source)) return "installed";
    requireManagedPluginSource(install, source);
    return "partial";
  }
  return install.format.installState(install.format.parse(raw), provider);
}

export function resolveAgentHookConfigPath<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): string {
  return resolveAgentHookInstallPath(provider.install, options);
}

function resolveAgentHookInstallPath<TConfig>(
  install: AgentHookInstallStrategy<TConfig>,
  options: AgentHookInstallOptions,
): string {
  const configDir =
    options.configDir ??
    resolveConfiguredDirectory({
      install,
      env: options.env ?? process.env,
      homeDir: options.homeDir ?? homedir(),
    });
  return path.join(configDir, install.configFile);
}

export function buildAgentHookShellCommand<TConfig>(
  provider: AgentHookProvider<TConfig>,
  event: AgentHookEventDefinition,
): string {
  const hookCommand = `"\${PIMI_HOOK_CLI:-pimi}" hooks ${shellToken(provider.id)} ${shellToken(event.event)}`;
  return `if [ -n "$PIMI_TERMINAL_ID" ]; then ${hookCommand}; fi`;
}

export function buildAgentHookWindowsCommand<TConfig>(
  provider: AgentHookProvider<TConfig>,
  event: AgentHookEventDefinition,
): string {
  const hookArgs = `hooks ${windowsToken(provider.id)} ${windowsToken(event.event)}`;
  return `if defined PIMI_TERMINAL_ID (if defined PIMI_HOOK_CLI ("%PIMI_HOOK_CLI%" ${hookArgs}) else (pimi ${hookArgs})) else (exit /b 0)`;
}

function installAgentHookPluginFile(
  install: AgentHookPluginFileInstallStrategy,
  options: AgentHookInstallOptions,
): AgentHookInstallResult {
  const configPath = resolveAgentHookInstallPath(install, options);
  const currentRaw = readHookConfig(configPath);
  const nextRaw = normalizeRawConfig(install.source);

  if (currentRaw !== null) requireManagedPluginSource(install, normalizeRawConfig(currentRaw));

  if (currentRaw === null || normalizeRawConfig(currentRaw) !== nextRaw) {
    writePrivateFileAtomicSync(configPath, nextRaw);
    return { configPath, changed: true };
  }

  return { configPath, changed: false };
}

function uninstallAgentHookPluginFile(
  install: AgentHookPluginFileInstallStrategy,
  options: AgentHookInstallOptions,
): AgentHookInstallResult {
  const configPath = resolveAgentHookInstallPath(install, options);
  const currentRaw = readHookConfig(configPath);
  if (currentRaw === null) return { configPath, changed: false };

  requireManagedPluginSource(install, normalizeRawConfig(currentRaw));
  rmSync(configPath, { force: true });
  return { configPath, changed: true };
}

function updateAgentHookConfig<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions,
  update: (config: TConfig) => TConfig,
): AgentHookInstallResult {
  const install = provider.install;
  if (install.kind !== "config-file") {
    throw new Error(`Provider ${provider.id} does not use config-file hooks`);
  }
  const configPath = resolveAgentHookConfigPath(provider, options);
  const currentRaw = readHookConfig(configPath);
  const currentConfig =
    currentRaw === null ? install.format.empty() : install.format.parse(currentRaw);
  const nextConfig = update(currentConfig);
  if (nextConfig === currentConfig) return { configPath, changed: false };
  const nextRaw = install.format.stringify(nextConfig);

  if (currentRaw === null || nextRaw !== normalizeRawConfig(currentRaw)) {
    writePrivateFileAtomicSync(configPath, nextRaw);
    return { configPath, changed: true };
  }

  return { configPath, changed: false };
}

// Managed hooks are small configuration documents. Limit synchronous reads on the daemon.
const MAX_HOOK_CONFIG_BYTES = 1024 * 1024;

function readHookConfig(configPath: string): string | null {
  let fd: number | undefined;
  try {
    const metadata = lstatSync(configPath);
    if (!metadata.isFile()) throw new Error("Hook configuration is not a regular file");
    fd = openSync(
      configPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error("Hook configuration changed during inspection");
    }
    if (opened.size > MAX_HOOK_CONFIG_BYTES) {
      throw new Error("Hook configuration exceeds the managed size limit");
    }

    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length !== opened.size) throw new Error("Hook configuration changed during inspection");
    return buffer.toString("utf8", 0, length);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function requireManagedPluginSource(install: AgentHookPluginFileInstallStrategy, source: string) {
  if (source === normalizeRawConfig(install.source)) return;
  const digest = createHash("sha256").update(source).digest("hex");
  if (install.legacySourceDigests?.includes(digest)) return;
  throw new Error("Hook plugin differs from all managed versions");
}

function resolveConfiguredDirectory<TConfig>(input: {
  install: AgentHookInstallStrategy<TConfig>;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string {
  const overrideName = input.install.configDirEnvOverride;
  const override = overrideName ? input.env[overrideName] : undefined;
  if (override) {
    return override;
  }

  if (input.install.configDirBase === "xdg-config") {
    return path.join(resolveXdgConfigHome(input), input.install.configDir);
  }

  return path.join(input.homeDir, input.install.configDir);
}

function resolveXdgConfigHome(input: { env: NodeJS.ProcessEnv; homeDir: string }): string {
  if (input.env.XDG_CONFIG_HOME) {
    return input.env.XDG_CONFIG_HOME;
  }

  return path.join(input.homeDir, ".config");
}

function normalizeRawConfig(raw: string): string {
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsToken(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}
