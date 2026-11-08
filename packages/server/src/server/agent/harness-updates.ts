import type {
  ProviderHarnessUpdate,
  ProviderHarnessUpdateChannel,
} from "@getpaseo/protocol/provider-harness-updates";
import compareVersions from "semver/functions/compare.js";
import validVersion from "semver/functions/valid.js";
import { basename } from "node:path";
import { realpath } from "node:fs/promises";
import { execCommand } from "../../utils/spawn.js";
import {
  checkProviderLaunchAvailable,
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderLaunchDefault,
  type ProviderRuntimeSettings,
} from "./provider-launch-config.js";

export interface HarnessInstallation {
  channel: ProviderHarnessUpdateChannel;
  version: string;
}

type ProbedHarness = "claude" | "codex" | "copilot" | "omp" | "opencode" | "pi";

const npm = "https://registry.npmjs.org";
const releases = {
  "claude-stable": `${npm}/@anthropic-ai%2fclaude-code/stable`,
  "codex-cli": `${npm}/@openai%2fcodex/latest`,
  copilot: `${npm}/@github%2fcopilot/latest`,
  omp: `${npm}/@oh-my-pi%2fpi-coding-agent/latest`,
  "opencode-v1": `${npm}/opencode-ai/latest`,
  "opencode-v2": "https://opencode.ai/update/api/latest/cli/npm",
  pi: `${npm}/@earendil-works%2fpi-coding-agent/latest`,
} satisfies Record<Exclude<ProviderHarnessUpdateChannel, "codex-app">, string>;

const PROBE_TIMEOUT_MS = 5_000;
const RELEASE_TIMEOUT_MS = 5_000;
const RELEASE_CACHE_MS = 30 * 60_000;
const RELEASE_RETRY_MS = 60_000;
const MAX_RELEASE_BYTES = 64 * 1024;

const outputPatterns: Record<ProbedHarness, RegExp> = {
  claude: /^([^\s]+)\s+\(Claude Code\)$/im,
  codex: /^codex(?:-cli)?\s+([^\s]+)$/im,
  copilot: /^(?:(?:GitHub )?Copilot(?: CLI)?\s+)?([^\s]+)$/im,
  omp: /^omp[\s/]([^\s]+)$/im,
  opencode: /^(?:opencode\s+)?([^\s]+)$/im,
  pi: /^([^\s]+)$/m,
};

const probeEnv = {
  claude: { DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1", FORCE_AUTOUPDATE_PLUGINS: undefined },
  codex: {},
  copilot: { COPILOT_AUTO_UPDATE: "false" },
  omp: {},
  opencode: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
  pi: {},
} satisfies Record<ProbedHarness, Record<string, string | undefined>>;

export async function probeHarnessInstallation(
  harness: ProbedHarness,
  settings?: ProviderRuntimeSettings,
  defaultBinary: string | ProviderLaunchDefault = harness,
): Promise<HarnessInstallation | null> {
  const launch = await resolveProviderLaunch({ commandConfig: settings?.command, defaultBinary });
  // Automatic checks call only a known CLI's version flag, never a wrapper or its arguments.
  const commandName = basename(launch.command)
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();
  if (commandName !== harness || (launch.source === "override" && launch.args.length > 0)) {
    return null;
  }
  const fallback = typeof defaultBinary === "string" ? undefined : defaultBinary;
  const { resolvedPath } = await checkProviderLaunchAvailable(launch, fallback);
  if (!resolvedPath) return null;

  try {
    const { stdout, stderr } = await execCommand(resolvedPath, ["--version"], {
      ...createProviderEnvSpec({ runtimeSettings: settings, overlays: [probeEnv[harness]] }),
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4_096,
    });
    const raw = `${stdout}\n${stderr}`.trim();
    const candidate = raw
      .split(/\r?\n/)
      .map((line) => outputPatterns[harness].exec(line)?.[1])
      .find((value) => value && validVersion(value));
    const version = candidate ? validVersion(candidate) : null;
    if (!version) return null;
    const channel = await installationChannel(harness, version, resolvedPath);
    return channel ? { channel, version } : null;
  } catch {
    return null;
  }
}

async function installationChannel(
  harness: ProbedHarness,
  version: string,
  executable: string,
): Promise<ProviderHarnessUpdateChannel | null> {
  switch (harness) {
    case "claude":
      return "claude-stable";
    case "copilot":
    case "omp":
    case "pi":
      return harness;
    case "codex": {
      const path = await realpath(executable).catch(() => executable);
      return /\.app[\\/]Contents[\\/]/i.test(path) || /[\\/]WindowsApps[\\/]/i.test(path)
        ? "codex-app"
        : "codex-cli";
    }
    case "opencode":
      if (version.startsWith("1.")) return "opencode-v1";
      if (version.startsWith("2.")) return "opencode-v2";
      return null;
  }
}

async function fetchReleaseVersion(url: string): Promise<string | null> {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RELEASE_BYTES) return null;
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const release: unknown = JSON.parse(body);
    if (typeof release !== "object" || !release || !("version" in release)) return null;
    return typeof release.version === "string" ? validVersion(release.version) : null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

type ReleaseChannel = keyof typeof releases;

export class HarnessUpdateCatalog {
  private readonly cache = new Map<ReleaseChannel, { version: string | null; checkedAt: number }>();
  private readonly inFlight = new Map<ReleaseChannel, Promise<string | null>>();

  private release(channel: ReleaseChannel, force: boolean): Promise<string | null> {
    const cached = this.cache.get(channel);
    if (cached) {
      const ttl = force || cached.version === null ? RELEASE_RETRY_MS : RELEASE_CACHE_MS;
      if (Date.now() < cached.checkedAt + ttl) return Promise.resolve(cached.version);
    }
    const running = this.inFlight.get(channel);
    if (running) return running;
    const request = fetchReleaseVersion(releases[channel])
      .catch(() => null)
      .then((version) => {
        this.cache.set(channel, { version, checkedAt: Date.now() });
        return version;
      })
      .finally(() => this.inFlight.delete(channel));
    this.inFlight.set(channel, request);
    return request;
  }

  async check(
    provider: string,
    label: string,
    installation: HarnessInstallation,
    force: boolean,
  ): Promise<ProviderHarnessUpdate> {
    const { channel, version: installedVersion } = installation;
    const common = { provider, label, channel, installedVersion };
    if (channel === "codex-app") return { ...common, latestVersion: null, status: "managed" };
    const latestVersion = await this.release(channel, force);
    const releaseLine = channel.startsWith("opencode-") ? installedVersion.split(".")[0] : null;
    if (!latestVersion || (releaseLine && !latestVersion.startsWith(`${releaseLine}.`))) {
      return { ...common, latestVersion: null, status: "unavailable" };
    }
    return {
      ...common,
      latestVersion,
      status: compareVersions(installedVersion, latestVersion) < 0 ? "update_available" : "current",
    };
  }
}
