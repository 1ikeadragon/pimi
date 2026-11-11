import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import { ExternalCliCommandError } from "./cli/external";
import {
  createDaemonCommandHandlers,
  keepsTerminalsOnStop,
  stopCapturedDaemon,
  type DesktopDaemonStopReason,
} from "./daemon-manager";

const mocks = vi.hoisted(() => ({
  paseoHome: "",
  settings: {
    releaseChannel: "stable",
    daemon: {
      manageBuiltInDaemon: true,
      keepRunningAfterQuit: true,
    },
  },
  runExternalCliJsonCommand: vi.fn(),
  runExternalCliTextCommand: vi.fn(),
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: [],
    env: {},
  })),
  spawnProcess: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  appLogPath: "",
  getElectronLogFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.paseoHome),
    getVersion: vi.fn(() => "1.2.3"),
    isPackaged: true,
  },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("electron-log/main", () => ({
  default: {
    info: mocks.logInfo,
    error: mocks.logError,
    transports: {
      file: {
        getFile: mocks.getElectronLogFile,
      },
    },
  },
}));

vi.mock("@pimi/server/daemon-control", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePaseoHome: () => mocks.paseoHome,
  spawnProcess: mocks.spawnProcess,
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => mocks.settings,
    patch: vi.fn(),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint: vi.fn(() => ({
    entryPath: path.join(mocks.paseoHome, "daemon.js"),
    execArgv: [],
  })),
}));

vi.mock("./cli/external.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: mocks.runExternalCliTextCommand,
}));

describe("daemon-manager commands", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo daemon manager "));
    mocks.paseoHome = path.join(fixtureRoot, "home");
    mocks.appLogPath = path.join(fixtureRoot, "main.log");
    mocks.settings = DEFAULT_DESKTOP_SETTINGS;
    mocks.runExternalCliJsonCommand.mockReset();
    mocks.runExternalCliTextCommand.mockReset();
    mocks.createNodeEntrypointInvocation.mockReset();
    mocks.createNodeEntrypointInvocation.mockReturnValue({ command: "node", args: [], env: {} });
    mocks.spawnProcess.mockReset();
    mocks.logInfo.mockReset();
    mocks.logError.mockReset();
    mocks.getElectronLogFile.mockReset();
    mocks.getElectronLogFile.mockReturnValue({ path: mocks.appLogPath });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("returns the Electron main-process log tail from electron-log", () => {
    writeFileSync(
      mocks.appLogPath,
      Array.from({ length: 105 }, (_value, index) => `main log line ${index + 1}`).join("\n"),
    );
    const handlers = createDaemonCommandHandlers();

    expect(handlers.desktop_app_logs()).toEqual({
      logPath: mocks.appLogPath,
      contents: Array.from({ length: 100 }, (_value, index) => `main log line ${index + 6}`).join(
        "\n",
      ),
    });
  });

  it("exposes updater diagnostics through the desktop command boundary", () => {
    const diagnostics = createDaemonCommandHandlers().desktop_update_diagnostics();

    expect(diagnostics).toMatchObject({
      platform: process.platform,
      currentVersion: "1.2.3",
    });
  });

  it("reports a stopped daemon without launching the CLI when no local daemon runs", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "server-id"), "srv_existing\n");
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      home: mocks.paseoHome,
      pid: null,
      startedAt: null,
      listen: null,
      hostname: null,
      localDaemon: "stopped",
      desktopManaged: false,
      connectedDaemon: "not_probed",
    });

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "stopped", pid: null });
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });

  it("reports an errored daemon when the local daemon state cannot be read", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "paseo.pid"), "garbage");

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "errored", pid: null });
    expect(status.error).toBeTruthy();
  });

  it("returns a local credential only for its live managed daemon listen", async () => {
    mkdirSync(mocks.paseoHome);
    const token = "a".repeat(43);
    writeFileSync(path.join(mocks.paseoHome, "local-credential"), `${token}\n`, { mode: 0o600 });
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    const handler = createDaemonCommandHandlers().desktop_local_credential;
    expect(await handler({ listen: "localhost:6799" })).toBe(token);
    expect(await handler({ listen: "remote:6799" })).toBeNull();
    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: false }));
    expect(await handler({ listen: "localhost:6799" })).toBeNull();
  });

  describe("version check on start", () => {
    const APP_VERSION = "1.2.3";
    const OLD_VERSION = "1.2.2";
    const LISTEN = "127.0.0.1:6799";
    const IDLE_PROCESS = "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);";
    // Stands in for the supervisor desktop launches: it publishes the lock the real one would.
    const BUNDLED_SUPERVISOR = `
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      fs.mkdirSync(process.env.PASEO_HOME, { recursive: true });
      fs.writeFileSync(
        path.join(process.env.PASEO_HOME, "paseo.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: os.hostname(),
          uid: process.getuid ? process.getuid() : 0,
          listen: "${LISTEN}",
          ...(process.env.PASEO_DESKTOP_MANAGED === "1" ? { desktopManaged: true } : {}),
        }),
      );
      ${IDLE_PROCESS}
    `;

    interface RunningProcess {
      pid: number;
      isAlive(): boolean;
      exited: Promise<unknown>;
    }

    interface FakeCli {
      stopRequests: string[][];
      versions: Map<number, string | null>;
      afterStatus: (() => void) | null;
      agentQueries: string[][];
      listAgents: () => unknown;
    }

    let processes: ChildProcess[];

    function lockPath(): string {
      return path.join(mocks.paseoHome, "paseo.pid");
    }

    function readLock(): { pid: number; startedAt: string; desktopManaged?: boolean } {
      return JSON.parse(readFileSync(lockPath(), "utf8"));
    }

    async function startProcess(): Promise<RunningProcess> {
      const child = spawn(process.execPath, ["-e", IDLE_PROCESS], { stdio: "ignore" });
      processes.push(child);
      const exited = once(child, "exit");
      await once(child, "spawn");
      return {
        pid: child.pid as number,
        isAlive: () => child.exitCode === null && child.signalCode === null,
        exited,
      };
    }

    function publishLock(pid: number, options: { desktopManaged: boolean }): void {
      mkdirSync(mocks.paseoHome, { recursive: true });
      writeFileSync(
        lockPath(),
        JSON.stringify({
          pid,
          startedAt: new Date().toISOString(),
          hostname: hostname(),
          uid: process.getuid?.() ?? 0,
          listen: LISTEN,
          ...(options.desktopManaged ? { desktopManaged: true } : {}),
        }),
      );
    }

    async function startRunningDaemon(options: {
      desktopManaged: boolean;
      version: string | null;
      cli: FakeCli;
    }): Promise<RunningProcess> {
      const daemon = await startProcess();
      publishLock(daemon.pid, options);
      options.cli.versions.set(daemon.pid, options.version);
      return daemon;
    }

    /** Answers `daemon status` from the lock in the test home and `daemon stop` by ending its owner. */
    function installFakeCli(): FakeCli {
      const cli: FakeCli = {
        stopRequests: [],
        versions: new Map(),
        afterStatus: null,
        agentQueries: [],
        listAgents: () => [],
      };
      mocks.runExternalCliJsonCommand.mockImplementation(async (args: string[]) => {
        if (args[0] === "agent") {
          cli.agentQueries.push(args);
          return cli.listAgents();
        }
        if (args[1] === "stop") {
          cli.stopRequests.push(args);
          process.kill(readLock().pid, "SIGTERM");
          return { action: "shutdown_requested" };
        }
        const lock = readLock();
        const version = cli.versions.has(lock.pid) ? cli.versions.get(lock.pid) : APP_VERSION;
        const payload = {
          localDaemon: "running",
          serverId: "srv_test",
          pid: lock.pid,
          startedAt: lock.startedAt,
          listen: LISTEN,
          hostname: hostname(),
          desktopManaged: lock.desktopManaged === true,
          ...(version ? { daemonVersion: version } : {}),
        };
        cli.afterStatus?.();
        cli.afterStatus = null;
        return payload;
      });
      return cli;
    }

    function versionCheckLogs(): unknown[] {
      return mocks.logInfo.mock.calls
        .filter((call) => call[1] === "daemon version check")
        .map((call) => call[2]);
    }

    beforeEach(() => {
      processes = [];
      mocks.createNodeEntrypointInvocation.mockReturnValue({
        command: process.execPath,
        args: ["-e", BUNDLED_SUPERVISOR],
        env: {},
      });
    });

    afterEach(() => {
      for (const child of processes) child.kill("SIGKILL");
      try {
        process.kill(readLock().pid, "SIGKILL");
      } catch {
        // No daemon was left in this test home.
      }
    });

    it("restarts an idle desktop-managed daemon left by an older app version", async () => {
      const cli = installFakeCli();
      cli.listAgents = () => [{ status: "idle" }, { status: "error" }, { status: "closed" }];
      const old = await startRunningDaemon({ desktopManaged: true, version: OLD_VERSION, cli });

      const status = await createDaemonCommandHandlers().start_desktop_daemon();

      await old.exited;
      expect(cli.stopRequests).toHaveLength(1);
      expect(cli.stopRequests[0].slice(0, 4)).toEqual(["daemon", "stop", "--host", LISTEN]);
      expect(status).toMatchObject({
        status: "running",
        pid: readLock().pid,
        version: APP_VERSION,
        desktopManaged: true,
        ownedByDesktop: true,
      });
      expect(readLock().pid).not.toBe(old.pid);
      expect(versionCheckLogs()).toEqual([
        expect.objectContaining({
          appVersion: APP_VERSION,
          daemonVersion: OLD_VERSION,
          ownedByDesktop: false,
          desktopManaged: true,
          agentActivity: "idle",
          restart: true,
        }),
      ]);
      expect(cli.agentQueries).toEqual([
        ["agent", "ls", "--global", "--background", "--home", mocks.paseoHome, "--json"],
      ]);
    });

    it.each(["running", "initializing"])(
      "attaches to an older desktop-managed daemon while an agent is %s",
      async (agentStatus) => {
        const cli = installFakeCli();
        const daemon = await startRunningDaemon({
          desktopManaged: true,
          version: OLD_VERSION,
          cli,
        });
        cli.listAgents = () => [{ status: "idle" }, { status: agentStatus }];

        const status = await createDaemonCommandHandlers().start_desktop_daemon();

        expect(status).toMatchObject({
          pid: daemon.pid,
          version: OLD_VERSION,
          ownedByDesktop: false,
        });
        expect(daemon.isAlive()).toBe(true);
        expect(cli.stopRequests).toEqual([]);
        expect(versionCheckLogs()).toEqual([
          expect.objectContaining({ agentActivity: "busy", restart: false }),
        ]);
      },
    );

    it("attaches to an older desktop-managed daemon when its agents cannot be listed", async () => {
      const cli = installFakeCli();
      const daemon = await startRunningDaemon({ desktopManaged: true, version: OLD_VERSION, cli });
      cli.listAgents = () => {
        throw new Error("daemon did not answer");
      };

      const status = await createDaemonCommandHandlers().start_desktop_daemon();

      expect(status).toMatchObject({ pid: daemon.pid, ownedByDesktop: false });
      expect(daemon.isAlive()).toBe(true);
      expect(cli.stopRequests).toEqual([]);
      expect(versionCheckLogs()).toEqual([
        expect.objectContaining({
          agentActivity: "unknown",
          agentActivityError: "daemon did not answer",
          restart: false,
        }),
      ]);
    });

    it("attaches to an older desktop-managed daemon when the agent list is unreadable", async () => {
      const cli = installFakeCli();
      const daemon = await startRunningDaemon({ desktopManaged: true, version: OLD_VERSION, cli });
      cli.listAgents = () => ({ agents: "not a list" });

      await createDaemonCommandHandlers().start_desktop_daemon();

      expect(daemon.isAlive()).toBe(true);
      expect(cli.stopRequests).toEqual([]);
      expect(versionCheckLogs()).toEqual([
        expect.objectContaining({ agentActivity: "unknown", restart: false }),
      ]);
    });

    it("leaves a daemon the user started on another version running", async () => {
      const cli = installFakeCli();
      const daemon = await startRunningDaemon({ desktopManaged: false, version: OLD_VERSION, cli });

      const status = await createDaemonCommandHandlers().start_desktop_daemon();

      expect(status).toMatchObject({
        pid: daemon.pid,
        version: OLD_VERSION,
        ownedByDesktop: false,
      });
      expect(daemon.isAlive()).toBe(true);
      expect(cli.stopRequests).toEqual([]);
      expect(versionCheckLogs()).toEqual([
        expect.objectContaining({
          appVersion: APP_VERSION,
          daemonVersion: OLD_VERSION,
          ownedByDesktop: false,
          desktopManaged: false,
          restart: false,
        }),
      ]);
    });

    it("restarts the daemon this app launched when its version differs", async () => {
      const cli = installFakeCli();
      const handlers = createDaemonCommandHandlers();
      const launched = await handlers.start_desktop_daemon();
      expect(launched).toMatchObject({ status: "running", ownedByDesktop: true });
      const launchedPid = readLock().pid;
      cli.versions.set(launchedPid, OLD_VERSION);
      cli.listAgents = () => [{ status: "running" }];

      const status = await handlers.start_desktop_daemon();

      expect(readLock().pid).not.toBe(launchedPid);
      expect(status).toMatchObject({
        pid: readLock().pid,
        version: APP_VERSION,
        ownedByDesktop: true,
      });
      expect(cli.stopRequests).toHaveLength(1);
    });

    it("attaches to a desktop-managed daemon on the app's version", async () => {
      const cli = installFakeCli();
      const daemon = await startRunningDaemon({ desktopManaged: true, version: APP_VERSION, cli });

      const status = await createDaemonCommandHandlers().start_desktop_daemon();

      expect(status).toMatchObject({
        pid: daemon.pid,
        version: APP_VERSION,
        ownedByDesktop: false,
      });
      expect(daemon.isAlive()).toBe(true);
      expect(cli.stopRequests).toEqual([]);
    });

    it("attaches to a desktop-managed daemon that reports no version", async () => {
      const cli = installFakeCli();
      const daemon = await startRunningDaemon({ desktopManaged: true, version: null, cli });

      const status = await createDaemonCommandHandlers().start_desktop_daemon();

      expect(status).toMatchObject({ pid: daemon.pid, version: null, ownedByDesktop: false });
      expect(daemon.isAlive()).toBe(true);
      expect(cli.stopRequests).toEqual([]);
    });

    it("does not stop a daemon that replaced the one it checked", async () => {
      const cli = installFakeCli();
      const checked = await startRunningDaemon({ desktopManaged: true, version: OLD_VERSION, cli });
      const replacement = await startProcess();
      cli.versions.set(replacement.pid, OLD_VERSION);
      cli.afterStatus = () => publishLock(replacement.pid, { desktopManaged: true });

      const status = await createDaemonCommandHandlers().start_desktop_daemon();

      expect(status).toMatchObject({ pid: replacement.pid, ownedByDesktop: false });
      expect(replacement.isAlive()).toBe(true);
      expect(checked.isAlive()).toBe(true);
      expect(cli.stopRequests).toEqual([]);
    });

    it("leaves an older desktop-managed daemon running while management is disabled", async () => {
      const cli = installFakeCli();
      const daemon = await startRunningDaemon({ desktopManaged: true, version: OLD_VERSION, cli });
      mocks.settings = {
        ...DEFAULT_DESKTOP_SETTINGS,
        daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon, manageBuiltInDaemon: false },
      };

      await expect(createDaemonCommandHandlers().start_desktop_daemon()).rejects.toThrow(
        "Built-in daemon management is disabled.",
      );

      expect(daemon.isAlive()).toBe(true);
      expect(readLock().pid).toBe(daemon.pid);
      expect(cli.stopRequests).toEqual([]);
    });

    it("keeps automatic stops away from an attached desktop-managed daemon", async () => {
      const cli = installFakeCli();
      const daemon = await startRunningDaemon({ desktopManaged: true, version: OLD_VERSION, cli });
      const stop = createDaemonCommandHandlers().stop_desktop_daemon;

      for (const reason of ["quit", "settings", "app_update", "host_remove", "version_mismatch"]) {
        expect(await stop({ reason })).toMatchObject({ pid: daemon.pid });
      }
      await expect(
        stop({ reason: "version_mismatch", pid: daemon.pid, startedAt: "outdated-confirmation" }),
      ).rejects.toThrow("Daemon changed since confirmation");
      await expect(
        stop({ reason: "quit", pid: daemon.pid, startedAt: readLock().startedAt }),
      ).rejects.toThrow("Daemon changed since confirmation");

      expect(daemon.isAlive()).toBe(true);
      expect(cli.stopRequests).toEqual([]);
    });

    it("stops an attached daemon for a version restart the user confirmed", async () => {
      const cli = installFakeCli();
      const daemon = await startRunningDaemon({ desktopManaged: true, version: OLD_VERSION, cli });
      cli.listAgents = () => [{ status: "running" }];
      const handlers = createDaemonCommandHandlers();

      const stopped = await handlers.stop_desktop_daemon({
        reason: "version_mismatch",
        pid: daemon.pid,
        startedAt: readLock().startedAt,
      });
      await daemon.exited;
      const status = await handlers.start_desktop_daemon();

      expect(stopped).toMatchObject({ status: "stopped" });
      expect(cli.stopRequests[0].includes("--keep-terminals")).toBe(process.platform !== "win32");
      expect(status).toMatchObject({ version: APP_VERSION, ownedByDesktop: true });
    });
  });
});

describe("desktop stops and terminals", () => {
  const reasons: DesktopDaemonStopReason[] = [
    "manual_ipc",
    "settings",
    "host_remove",
    "quit",
    "app_update",
    "version_mismatch",
    "restart",
  ];

  it("keeps terminals only for an app update or version-mismatch restart, never on Windows", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(reasons.filter((reason) => keepsTerminalsOnStop(reason, platform))).toEqual([
        "app_update",
        "version_mismatch",
      ]);
    }
    expect(reasons.filter((reason) => keepsTerminalsOnStop(reason, "win32"))).toEqual([]);
  });

  function stopHarness(runCliJson: (args: string[]) => Promise<unknown>) {
    const stops: Array<{ keepTerminals: boolean | undefined }> = [];
    const instance = {
      pid: 4242,
      startedAt: "2026-10-21T00:00:00.000Z",
      hostname: "host",
      uid: 501,
      listen: "127.0.0.1:6799",
    };
    const stopInstance = (async (
      _home: string,
      options: {
        keepTerminals?: boolean;
        requestShutdown?: (ready: { listen: string }) => Promise<void>;
      },
    ) => {
      stops.push({ keepTerminals: options.keepTerminals });
      await options.requestShutdown?.({ listen: instance.listen });
      return { action: "stopped", pid: instance.pid, forced: false, usedLifecycleRpc: true };
    }) as unknown as NonNullable<Parameters<typeof stopCapturedDaemon>[0]["stopInstance"]>;
    return {
      stops,
      input: {
        home: "/tmp/paseo-home",
        instance,
        stopInstance,
        runCliJson,
      } as Omit<Parameters<typeof stopCapturedDaemon>[0], "reason" | "keepTerminals">,
    };
  }

  it("asks the daemon to keep its terminals on an app update", async () => {
    const calls: string[][] = [];
    const harness = stopHarness(async (args) => {
      calls.push(args);
      return { action: "shutdown_requested" };
    });

    await stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true });

    expect(harness.stops).toEqual([{ keepTerminals: true }]);
    expect(calls).toEqual([
      ["daemon", "stop", "--host", "127.0.0.1:6799", "--keep-terminals", "--json"],
    ]);
  });

  it("does not retry a keep stop that failed for another reason", async () => {
    const harness = stopHarness(async () => {
      throw new ExternalCliCommandError("unreachable", { code: "DAEMON_UNREACHABLE" });
    });

    await expect(
      stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true }),
    ).rejects.toThrow("unreachable");
    expect(harness.stops).toEqual([{ keepTerminals: true }]);
  });
});
