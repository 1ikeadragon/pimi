import path from "node:path";
import { app } from "electron";
import type {
  DesktopTargetCommand,
  DesktopTargetResult,
} from "@pimi/protocol/desktop-target/rpc-schemas";
import { appReport } from "../app-report.js";
import { isElementRef, type DesktopGuard } from "../guard.js";
import { forbiddenWinTarget, parseWinChord, parseWinKeys, refuseWinChord } from "./guard-win.js";
import { helperRequest, HelperError, type HelperTarget } from "../helper-process.js";
import { checkProbe, type SecurityInput } from "../security.js";
import {
  candidateScope,
  checkDataDir,
  checkDeeplink,
  runFiles,
  runNetwork,
  runSecretsScan,
} from "./security-win.js";

// The Windows side of Attack's desktop target. The main process applies the guard (deny list,
// input consent, chords, ref shapes) and builds the helper's Target from it; the helper resolves
// the window, gates every input and does the work. The agent never names a window.

interface Pin {
  hwnd: string;
  pid: number;
  processStartedAt: string | null;
}

// Per run: where the helper last found the window. The helper answers `repinned` when it had to
// look for the window again (the app restarted, the handle was recycled).
const pins = new Map<string, Pin>();

function refuse(message: string): never {
  throw new HelperError("refused", message);
}

function installDir(): string | null {
  return app.isPackaged ? path.dirname(process.execPath) : null;
}

function targetFor(guard: DesktopGuard): HelperTarget {
  const pin = pins.get(guard.runId);
  const win = guard.win;
  return {
    appId: guard.bundleId,
    windowTitle: guard.windowTitle,
    hwnd: pin?.hwnd ?? win?.hwnd ?? null,
    pid: pin?.pid ?? win?.pid ?? null,
    processStartedAt: pin ? pin.processStartedAt : (win?.processStartedAt ?? null),
    windowClass: win?.windowClass ?? null,
    allowInput: guard.allowInput,
    allowRelaunch: guard.allowRelaunch,
    launchArgs: guard.launchArgs,
    disposable: guard.disposable,
  };
}

function requireRef(ref: string | undefined): void {
  if (ref !== undefined && !isElementRef(ref))
    refuse("That is not an element ref. Use one like @d12.");
}

function checkKeys(args: Extract<DesktopTargetCommand, { command: "key" }>["args"]): void {
  if (args.chord === undefined && args.keys === undefined) refuse("Pass a chord or keys.");
  for (const parsed of [
    args.chord !== undefined ? parseWinChord(args.chord) : null,
    args.keys !== undefined ? parseWinKeys(args.keys) : null,
  ]) {
    if (!parsed) continue;
    if (!parsed.ok) refuse(parsed.message);
    const refused = refuseWinChord(parsed);
    if (refused) refuse(refused);
  }
}

// Input verbs need the owner's consent, enforced here again after the daemon.
function needsInput(command: DesktopTargetCommand): boolean {
  switch (command.command) {
    case "click":
    case "type":
    case "key":
    case "scroll":
    case "drag":
    case "hover":
    case "mouse":
    case "deeplink":
      return true;
    case "window":
      return command.args.action !== "state";
    case "app":
      return command.args.action !== "status";
    case "ipc":
      return command.args.action === "probe";
    default:
      return false;
  }
}

// The read-tier security tools need the owner's allowDesktopInspect switch, enforced here again
// after the daemon.
function needsInspect(command: DesktopTargetCommand): boolean {
  switch (command.command) {
    case "inspect":
    case "secrets_scan":
    case "files":
    case "network":
      return true;
    case "ipc":
      return command.args.action === "list";
    default:
      return false;
  }
}

function checkCommand(command: DesktopTargetCommand, guard: DesktopGuard): void {
  if (needsInput(command) && !guard.allowInput) {
    refuse("The owner did not allow desktop input for this run.");
  }
  if (needsInspect(command) && !guard.allowInspect) {
    refuse("The owner did not allow security inspection for this run.");
  }
  switch (command.command) {
    case "click":
    case "scroll":
    case "hover":
    case "element":
      requireRef(command.args.element);
      break;
    case "type":
      requireRef(command.args.element);
      break;
    case "snapshot":
      requireRef(command.args.root);
      break;
    case "drag":
      requireRef(command.args.from.element);
      requireRef(command.args.to.element);
      break;
    case "wait":
      requireRef(command.args.element);
      break;
    case "key":
      checkKeys(command.args);
      break;
    case "deeplink":
      checkDeeplink(command.args.url);
      break;
    case "ipc":
      checkProbe(command.args);
      break;
    case "app":
      if (command.args.action !== "status" && !guard.allowRelaunch) {
        refuse("The owner did not allow launching or relaunching the app for this run.");
      }
      break;
    default:
      break;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function listResult(raw: Record<string, unknown>): DesktopTargetResult {
  const windows = Array.isArray(raw.windows) ? (raw.windows as Record<string, unknown>[]) : [];
  return {
    command: "list_windows",
    windows: windows
      .filter(
        (window) =>
          forbiddenWinTarget(
            {
              appId: str(window.appId),
              exeName: str(window.exeName),
              windowClass: str(window.windowClass),
            },
            installDir(),
          ) === null,
      )
      .map((window) => ({
        bundleId: str(window.appId),
        appName: str(window.appName),
        windowTitle: str(window.windowTitle),
        platform: "win32" as const,
        framework: str(window.framework),
        elevated: window.elevated === true,
        blocked: typeof window.blocked === "string" ? window.blocked : null,
        win: {
          hwnd: str(window.hwnd),
          pid: typeof window.pid === "number" ? window.pid : 0,
          processStartedAt:
            typeof window.processStartedAt === "string" ? window.processStartedAt : null,
          windowClass: str(window.windowClass),
          exeName: str(window.exeName),
          framework: str(window.framework),
        },
      })),
  };
}

export async function runWin(
  command: DesktopTargetCommand,
  guard: DesktopGuard,
  agentId: string,
): Promise<DesktopTargetResult> {
  if (command.command === "list_windows") {
    return listResult(await helperRequest({ verb: "list", agent: null, target: null, args: {} }));
  }
  const forbidden = forbiddenWinTarget(
    {
      appId: guard.bundleId,
      exeName: guard.win?.exeName,
      windowClass: guard.win?.windowClass,
    },
    installDir(),
  );
  if (forbidden) refuse(forbidden);
  checkCommand(command, guard);
  const security = await runSecurityLocally(command, { guard, agentId, target: targetFor(guard) });
  if (security) return security;
  const { repinned, ...result } = await helperRequest({
    verb: command.command,
    agent: agentId,
    target: targetFor(guard),
    args: command.args,
  });
  const pin = repinned as Partial<Pin> | undefined;
  if (pin && typeof pin.hwnd === "string" && typeof pin.pid === "number") {
    pins.set(guard.runId, {
      hwnd: pin.hwnd,
      pid: pin.pid,
      processStartedAt: typeof pin.processStartedAt === "string" ? pin.processStartedAt : null,
    });
  }
  // The helper's reply is checked against the wire schema by the daemon's broker.
  return { command: command.command, ...fill(command.command, result) } as DesktopTargetResult;
}

// The tools whose work is done here rather than in the helper (the helper supplies the scope).
async function runSecurityLocally(
  command: DesktopTargetCommand,
  input: SecurityInput,
): Promise<DesktopTargetResult | null> {
  switch (command.command) {
    case "secrets_scan":
      return runSecretsScan(command.args, input);
    case "files":
      return runFiles(command.args, input);
    case "network":
      return runNetwork(input);
    default:
      return null;
  }
}

// Click results name what was hit; the schema wants them present.
function fill(command: string, result: Record<string, unknown>): Record<string, unknown> {
  switch (command) {
    case "click":
      return { role: null, label: null, point: null, ...result };
    case "inspect":
    case "ipc":
      return { report: "", structured: {}, ...result };
    case "deeplink":
      return { launched: false, handler: null, ...result };
    case "app":
      return { report: appReport(result) };
    default:
      return result;
  }
}

export interface WinScopeRequest {
  bundleId: string;
  windowTitle: string;
  win: {
    hwnd: string;
    pid: number;
    processStartedAt: string | null;
    windowClass: string;
  };
}

/** The data dirs the launch form proposes for a picked window (the owner confirms or edits them). */
export async function resolveWinScope(
  request: WinScopeRequest,
): Promise<{ installDir: string | null; dataDirs: string[] }> {
  return candidateScope({
    appId: request.bundleId,
    windowTitle: request.windowTitle,
    hwnd: request.win.hwnd,
    pid: request.win.pid,
    processStartedAt: request.win.processStartedAt,
    windowClass: request.win.windowClass,
    allowInput: false,
    allowRelaunch: false,
    launchArgs: "",
    disposable: false,
  });
}

/** A directory the owner typed: its canonical path, or null when it is not allowed. */
export function checkWinDataDir(raw: string): Promise<string | null> {
  return checkDataDir(raw);
}

/** The run is over: forget its pin. */
export function forgetWinRun(runId: string): void {
  pins.delete(runId);
}
