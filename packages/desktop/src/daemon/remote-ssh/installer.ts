import { createReadStream } from "node:fs";
import {
  REMOTE_BUNDLE_ARCHES,
  REMOTE_DAEMON_PORT_DEFAULT,
  REMOTE_NODE_MIN_MAJOR,
  REMOTE_NODE_SHA256,
  REMOTE_NODE_VERSION,
  type RemoteBundleArch,
} from "./bundle-spec.js";
import { resolveLocalBundle } from "./bundle-source.js";
import { RemoteSshError } from "./errors.js";
import {
  EXTRACT_SCRIPT,
  NODE_SCRIPT,
  PREPARE_SCRIPT,
  PROBE_SCRIPT,
  START_SCRIPT,
  UPLOAD_COMMAND,
} from "./remote-scripts.js";
import { parseFacts, runRemoteScript, runSsh, type SshTarget } from "./ssh-exec.js";

export type RemoteSshStep = "connecting" | "checking" | "installing" | "starting" | "connected";

export interface RemoteSshProgress {
  step: RemoteSshStep;
  message: string;
  /** 0..1 within the current step, when known. */
  fraction?: number;
}

export interface RemoteSshEnsureInput extends SshTarget {
  daemonPort?: number;
  /** "systemd" asks for a systemd --user unit when the machine has one; otherwise nohup + setsid. */
  service?: "nohup" | "systemd";
  /**
   * "ask" (the default) leaves a running daemon of another version alone when it has agents or
   * terminals, and reports it through `onUpgradePending`; "now" replaces it regardless. A machine
   * the user is adding for the first time passes "now".
   */
  upgrade?: "ask" | "now";
}

export interface RemoteSshUpgradePending {
  host: string;
  sshPort?: number;
  daemonPort?: number;
  runningVersion: string;
  desktopVersion: string;
  busyAgents: number;
  terminals: number;
  /** True when the work could not be counted; treated like work. */
  unknown: boolean;
}

export interface RemoteSshEnsureDeps {
  appVersion: string;
  cacheDir: string;
  /** PIMI_REMOTE_DAEMON_BUNDLE_DIR, honored only by unpackaged builds. */
  devBundleDir: string | null;
  onProgress?: (progress: RemoteSshProgress) => void;
  onUpgradePending?: (pending: RemoteSshUpgradePending) => void;
  signal?: AbortSignal;
}

export interface RemoteSshEnsureResult {
  version: string;
  daemonPort: number;
  /** What was done: nothing, started a stopped daemon, installed it, or upgraded it. */
  action: "ready" | "started" | "installed" | "upgraded" | "deferred";
  service: "nohup" | "systemd";
  systemdAvailable: boolean;
}

interface Probe {
  os: string;
  machine: string;
  libc: string;
  home: string;
  diskKb: number | null;
  nodes: { path: string; version: string }[];
  systemd: boolean;
  unit: boolean;
  runtimes: string[];
  status: { version: string | null } | null;
  hasLock: boolean;
  wsReady: boolean;
  /** Null when no daemon answered or it could not be asked. */
  activity: { busyAgents: number; terminals: number } | "unknown" | null;
}

function parseProbe(stdout: string): Probe {
  const facts = parseFacts(stdout);
  const one = (key: string): string => facts.get(key)?.[0] ?? "";
  let status: Probe["status"] = null;
  const rawStatus = one("status");
  if (rawStatus) {
    try {
      const parsed = JSON.parse(rawStatus) as { version?: unknown };
      status = { version: typeof parsed.version === "string" ? parsed.version : null };
    } catch {
      status = { version: null };
    }
  }
  return {
    os: one("os"),
    machine: one("machine"),
    libc: one("libc"),
    home: one("home"),
    diskKb: Number.parseInt(one("diskKb"), 10) || null,
    nodes: (facts.get("node") ?? []).flatMap((entry) => {
      const index = entry.lastIndexOf(" ");
      return index > 0 ? [{ path: entry.slice(0, index), version: entry.slice(index + 1) }] : [];
    }),
    systemd: facts.has("systemd"),
    unit: facts.has("unit"),
    runtimes: facts.get("runtime") ?? [],
    status,
    hasLock: facts.has("lock"),
    wsReady: facts.has("wsReady"),
    activity: parseActivity(facts),
  };
}

function parseActivity(facts: Map<string, string[]>): Probe["activity"] {
  if (facts.has("activity")) return "unknown";
  const agents = Number.parseInt(facts.get("busyAgents")?.[0] ?? "", 10);
  const terminals = Number.parseInt(facts.get("terminals")?.[0] ?? "", 10);
  if (Number.isNaN(agents) || Number.isNaN(terminals)) return null;
  return { busyAgents: agents, terminals };
}

function chooseService(input: RemoteSshEnsureInput, probe: Probe): "nohup" | "systemd" {
  if (input.service === "systemd" && probe.systemd) return "systemd";
  return probe.unit && input.service !== "nohup" ? "systemd" : "nohup";
}

function archOf(machine: string): RemoteBundleArch | null {
  if (machine === "x86_64" || machine === "amd64") return "x64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  return null;
}

function nodeMajor(version: string): number {
  return Number.parseInt(version.replace(/^v/u, ""), 10) || 0;
}

function assertSupported(host: string, probe: Probe): RemoteBundleArch {
  if (probe.os !== "Linux") {
    throw new RemoteSshError(
      "UNSUPPORTED_OS",
      `${host} runs ${probe.os || "an unknown OS"}. Pimi installs its daemon on Linux (x86_64 or arm64) only. Use a Linux machine, or run the daemon on this one yourself and add it as a direct connection.`,
    );
  }
  const arch = archOf(probe.machine);
  if (!arch || !REMOTE_BUNDLE_ARCHES.includes(arch)) {
    throw new RemoteSshError(
      "UNSUPPORTED_ARCH",
      `${host} has a ${probe.machine || "unknown"} CPU. Pimi installs its daemon on x86_64 and arm64 Linux only.`,
    );
  }
  if (probe.libc === "musl") {
    throw new RemoteSshError(
      "UNSUPPORTED_LIBC",
      `${host} uses musl libc (for example Alpine). Pimi's daemon needs a glibc Linux such as Ubuntu, Debian or Fedora.`,
    );
  }
  return arch;
}

const ESTIMATED_INSTALL_KB = 900_000;
const keyOf = (input: RemoteSshEnsureInput): string =>
  `${input.host}|${input.sshPort ?? ""}|${input.daemonPort ?? ""}`;
const inFlight = new Map<string, Promise<RemoteSshEnsureResult>>();

/**
 * Makes the remote dev machine run this desktop's daemon version, bound to 127.0.0.1: probes it,
 * installs or upgrades the daemon when needed, starts it when stopped, and waits for health.
 * Concurrent calls for one machine share one run.
 */
export function ensureRemoteDaemon(
  input: RemoteSshEnsureInput,
  deps: RemoteSshEnsureDeps,
): Promise<RemoteSshEnsureResult> {
  const key = keyOf(input);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = ensureRemoteDaemonOnce(input, deps).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

interface InstallContext {
  target: SshTarget;
  deps: RemoteSshEnsureDeps;
  report: (step: RemoteSshStep, message: string, fraction?: number) => void;
  arch: RemoteBundleArch;
  host: string;
}

/** Puts Node.js (when the machine has none that is new enough) and the daemon bundle on the remote. */
async function installRuntime(
  ctx: InstallContext,
  state: { installed: boolean; nodePath: string | null; diskKb: number | null },
): Promise<string> {
  const { target, deps, report, arch, host } = ctx;
  const { appVersion } = deps;
  const common = { signal: deps.signal };
  report("installing", `Installing Pimi ${appVersion}`);
  if (state.diskKb !== null && state.diskKb < ESTIMATED_INSTALL_KB) {
    throw new RemoteSshError(
      "DISK_FULL",
      `The remote machine has only ${Math.round(state.diskKb / 1024)} MB free in its home directory and Pimi needs about 900 MB. Free some space and try again.`,
    );
  }
  await runRemoteScript(target, PREPARE_SCRIPT, [String(ESTIMATED_INSTALL_KB)], common);

  let nodePath = state.nodePath;
  if (!nodePath) {
    report("installing", `Downloading Node.js ${REMOTE_NODE_VERSION} on ${host}`);
    const out = await runRemoteScript(
      target,
      NODE_SCRIPT,
      [REMOTE_NODE_VERSION, arch, REMOTE_NODE_SHA256[arch]],
      {
        ...common,
        timeoutMs: 10 * 60_000,
      },
    );
    nodePath = /^nodePath=(.+)$/mu.exec(out)?.[1]?.trim() ?? null;
    if (!nodePath) {
      throw new RemoteSshError(
        "NODE_EXTRACT",
        "Node.js was installed but its path was not reported.",
      );
    }
  }
  if (!state.installed) await uploadRuntime(ctx);
  return nodePath;
}

async function uploadRuntime(ctx: InstallContext): Promise<void> {
  const { target, deps, report, arch } = ctx;
  const { appVersion } = deps;
  let lastDownloadPercent = -1;
  report("installing", `Preparing the Pimi ${appVersion} daemon for Linux ${arch}`);
  const bundle = await resolveLocalBundle({
    version: appVersion,
    arch,
    cacheDir: deps.cacheDir,
    devBundleDir: deps.devBundleDir,
    signal: deps.signal,
    onProgress: (received, total) => {
      const percent = total ? Math.floor((received / total) * 100) : Math.floor(received / 1048576);
      if (percent === lastDownloadPercent) return;
      lastDownloadPercent = percent;
      report(
        "installing",
        `Downloading the daemon (${Math.round(received / 1048576)} MB)`,
        total ? received / total : undefined,
      );
    },
  });
  report("installing", `Uploading Pimi ${appVersion}`, 0);
  await uploadBundle(target, appVersion, bundle.file, bundle.size, report, deps.signal);
  report("installing", `Verifying and unpacking Pimi ${appVersion}`);
  await runRemoteScript(target, EXTRACT_SCRIPT, [appVersion, bundle.sha256], {
    signal: deps.signal,
    timeoutMs: 5 * 60_000,
  });
}

/**
 * A running daemon of another version that has agents or terminals (or whose work cannot be
 * counted) is left alone, and the app is told so it can ask the user. Null means go ahead.
 */
function deferUpgradeWithWork(
  input: RemoteSshEnsureInput,
  deps: RemoteSshEnsureDeps,
  probe: Probe,
  runningVersion: string | null,
  port: number,
): RemoteSshEnsureResult | null {
  if (!runningVersion || runningVersion === deps.appVersion) return null;
  if (input.upgrade === "now" || !probe.activity) return null;
  const work = probe.activity === "unknown" ? null : probe.activity;
  if (work && !work.busyAgents && !work.terminals) return null;
  deps.onUpgradePending?.({
    host: input.host,
    ...(input.sshPort !== undefined ? { sshPort: input.sshPort } : {}),
    ...(input.daemonPort !== undefined ? { daemonPort: input.daemonPort } : {}),
    runningVersion,
    desktopVersion: deps.appVersion,
    busyAgents: work?.busyAgents ?? 0,
    terminals: work?.terminals ?? 0,
    unknown: work === null,
  });
  return {
    version: runningVersion,
    daemonPort: port,
    action: "deferred",
    service: probe.unit ? "systemd" : "nohup",
    systemdAvailable: probe.systemd,
  };
}

async function ensureRemoteDaemonOnce(
  input: RemoteSshEnsureInput,
  deps: RemoteSshEnsureDeps,
): Promise<RemoteSshEnsureResult> {
  const { appVersion } = deps;
  const port = input.daemonPort ?? REMOTE_DAEMON_PORT_DEFAULT;
  const target: SshTarget = {
    host: input.host,
    ...(input.sshPort !== undefined ? { sshPort: input.sshPort } : {}),
  };
  const report = (step: RemoteSshStep, message: string, fraction?: number) =>
    deps.onProgress?.({ step, message, ...(fraction !== undefined ? { fraction } : {}) });
  const common = { signal: deps.signal };

  report("connecting", `Connecting to ${input.host}`);
  const probeOut = await runRemoteScript(target, PROBE_SCRIPT, [String(port), appVersion], {
    ...common,
    timeoutMs: 45_000,
  });
  report("checking", `Checking ${input.host}`);
  const probe = parseProbe(probeOut);
  const arch = assertSupported(input.host, probe);
  const service = chooseService(input, probe);

  const runningVersion = probe.status?.version ?? null;
  const healthy = runningVersion === appVersion && probe.wsReady;
  const serviceMatches =
    input.service === undefined || (input.service === "systemd") === probe.unit;
  if (healthy && serviceMatches) {
    report("connected", `Pimi ${appVersion} is running on ${input.host}`);
    return {
      version: appVersion,
      daemonPort: port,
      action: "ready",
      service: probe.unit ? "systemd" : "nohup",
      systemdAvailable: probe.systemd,
    };
  }

  const deferred = deferUpgradeWithWork(input, deps, probe, runningVersion, port);
  if (deferred) {
    report("connected", `Pimi ${deferred.version} is running on ${input.host}; upgrade postponed`);
    return deferred;
  }

  const installed = probe.runtimes.includes(appVersion);
  const usableNode = probe.nodes.find((node) => nodeMajor(node.version) >= REMOTE_NODE_MIN_MAJOR);
  let nodePath = usableNode?.path ?? null;

  if (!installed || !nodePath) {
    nodePath = await installRuntime(
      { target, deps, report, arch, host: input.host },
      { installed, nodePath, diskKb: probe.diskKb },
    );
  }

  report("starting", `Starting Pimi ${appVersion} on ${input.host}`);
  await runRemoteScript(
    target,
    START_SCRIPT,
    [appVersion, String(port), nodePath, service, healthy ? "1" : "0"],
    {
      ...common,
      timeoutMs: 3 * 60_000,
    },
  );
  report("connected", `Pimi ${appVersion} is running on ${input.host}`);
  let action: RemoteSshEnsureResult["action"] = "started";
  if (!installed) action = runningVersion ? "upgraded" : "installed";
  return {
    version: appVersion,
    daemonPort: port,
    action,
    service,
    systemdAvailable: probe.systemd,
  };
}

async function uploadBundle(
  target: SshTarget,
  version: string,
  file: string,
  size: number,
  report: (step: RemoteSshStep, message: string, fraction?: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  let sent = 0;
  let lastPercent = -1;
  const stream = createReadStream(file);
  stream.on("data", (chunk) => {
    sent += chunk.length;
    const percent = Math.floor((sent / size) * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    report(
      "installing",
      `Uploading Pimi ${version} (${Math.round(sent / 1048576)} of ${Math.round(size / 1048576)} MB)`,
      sent / size,
    );
  });
  const result = await runSsh(target, UPLOAD_COMMAND(version), { stdin: stream, signal });
  if (result.code !== 0) {
    if (/no space left on device/iu.test(result.stderr)) {
      throw new RemoteSshError(
        "DISK_FULL",
        "The remote machine ran out of disk space while receiving the daemon. Free some space in its home directory and try again.",
        result.stderr,
      );
    }
    throw new RemoteSshError(
      "UPLOAD_FAILED",
      `Uploading the daemon to ${target.host} failed. Check the connection and try again.`,
      result.stderr,
    );
  }
}
