import { systemPreferences } from "electron";
import type {
  DesktopTargetCommand,
  DesktopTargetResult,
} from "@pimi/protocol/desktop-target/rpc-schemas";
import {
  AxError,
  clickElement,
  clickPoint,
  pressKey,
  resolveWindow,
  snapshotWindow,
  typeText,
} from "./ax.js";
import { forbiddenTarget, isElementPath, keyCodeFor, parseChord, refuseChord } from "./guard.js";
import { pointInFrame, type DesktopGuard } from "../guard.js";
import { helperRequest, type HelperTarget } from "../helper-process.js";

// The macOS side of Attack's desktop target: one window, chosen by the owner, driven through
// Accessibility. Every call re-resolves the window from the guard: a closed window or a different
// title fails the call instead of moving to another window.

const OWN_PID = process.pid;

interface Pin {
  windowId: string;
  pid: number;
  processStartedAt: string | null;
}

// Per run: where the helper last found the window. The helper answers `repinned` when it had to
// look for the window again (the app restarted, the window id was recycled).
const pins = new Map<string, Pin>();

function targetFor(guard: DesktopGuard): HelperTarget {
  const pin = pins.get(guard.runId);
  const win = guard.win;
  return {
    appId: guard.bundleId,
    windowTitle: guard.windowTitle,
    hwnd: pin?.windowId ?? win?.hwnd ?? null,
    pid: pin?.pid ?? win?.pid ?? null,
    processStartedAt: pin ? pin.processStartedAt : (win?.processStartedAt ?? null),
    windowClass: null,
    allowInput: guard.allowInput,
    allowRelaunch: guard.allowRelaunch,
    launchArgs: guard.launchArgs,
    disposable: guard.disposable,
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function helperVerb(
  command: DesktopTargetCommand,
  guard: DesktopGuard,
  agentId: string,
): Promise<Record<string, unknown>> {
  const { repinned, ...result } = await helperRequest({
    verb: command.command,
    agent: agentId,
    target: targetFor(guard),
    args: command.args,
  });
  const pin = repinned as { hwnd?: unknown; pid?: unknown; processStartedAt?: unknown } | undefined;
  if (pin && typeof pin.hwnd === "string" && typeof pin.pid === "number") {
    pins.set(guard.runId, {
      windowId: pin.hwnd,
      pid: pin.pid,
      processStartedAt: typeof pin.processStartedAt === "string" ? pin.processStartedAt : null,
    });
  }
  return result;
}

export function screenGranted(): boolean {
  return systemPreferences.getMediaAccessStatus("screen") === "granted";
}

function listResult(raw: Record<string, unknown>): DesktopTargetResult {
  const windows = Array.isArray(raw.windows) ? (raw.windows as Record<string, unknown>[]) : [];
  return {
    command: "list_windows",
    windows: windows
      .filter((window) => forbiddenTarget(str(window.appId)) === null)
      .map((window) => ({
        bundleId: str(window.appId),
        appName: str(window.appName),
        windowTitle: str(window.windowTitle),
        platform: "darwin" as const,
        framework: str(window.framework),
        elevated: window.elevated === true,
        blocked: typeof window.blocked === "string" ? window.blocked : null,
        win: {
          hwnd: str(window.hwnd),
          pid: typeof window.pid === "number" ? window.pid : 0,
          processStartedAt:
            typeof window.processStartedAt === "string" ? window.processStartedAt : null,
          windowClass: "",
          exeName: str(window.exeName),
          framework: str(window.framework),
        },
      })),
  };
}

function requireInput(guard: DesktopGuard): void {
  if (!guard.allowInput) {
    throw new AxError("refused", "The owner did not allow desktop input for this run.");
  }
}

async function clickMac(
  args: Extract<DesktopTargetCommand, { command: "click" }>["args"],
  guard: DesktopGuard,
): Promise<DesktopTargetResult> {
  const { element, point } = args;
  if ((element === undefined) === (point === undefined)) {
    throw new AxError("refused", "Pass exactly one of an element path or a point.");
  }
  if (element !== undefined) {
    if (!isElementPath(element)) throw new AxError("refused", "That is not an element path.");
    const hit = await clickElement(guard, OWN_PID, element);
    return { command: "click", role: hit.role, label: hit.label, point: hit.point };
  }
  const window = await resolveWindow(guard, OWN_PID);
  if (!pointInFrame(point!, window.frame)) {
    throw new AxError("refused", "That point is outside the target window.");
  }
  const hit = await clickPoint(guard, OWN_PID, point!);
  return { command: "click", role: null, label: null, point: hit.point };
}

async function keyMac(
  args: Extract<DesktopTargetCommand, { command: "key" }>["args"],
  guard: DesktopGuard,
): Promise<DesktopTargetResult> {
  if (args.chord === undefined) {
    throw new AxError("refused", "Pass a chord, for example return or cmd+s.");
  }
  const chord = parseChord(args.chord);
  if (!chord.ok) throw new AxError("refused", chord.message);
  const refused = refuseChord(chord);
  if (refused) throw new AxError("refused", refused);
  const code = keyCodeFor(chord.key);
  await pressKey(guard, OWN_PID, code !== null ? { code } : { char: chord.key }, chord.modifiers);
  return { command: "key" };
}
export async function runMac(
  command: DesktopTargetCommand,
  guard: DesktopGuard,
  agentId: string,
): Promise<DesktopTargetResult> {
  if (command.command === "list_windows") {
    const raw = await helperRequest({ verb: "list", agent: null, target: null, args: {} });
    return listResult(raw);
  }
  const forbidden = forbiddenTarget(guard.bundleId);
  if (forbidden) throw new AxError("refused", forbidden);
  if (!screenGranted()) {
    throw new AxError(
      "permission_missing",
      "Pimi does not have Screen Recording access, so it cannot identify the target window. Grant it in System Settings > Privacy & Security > Screen Recording.",
    );
  }
  switch (command.command) {
    case "screenshot": {
      const result = await helperVerb(command, guard, agentId);
      return { command: "screenshot", ...result } as DesktopTargetResult;
    }
    case "snapshot": {
      const snapshot = await snapshotWindow(guard, OWN_PID);
      return { command: "snapshot", ...snapshot };
    }
    case "click":
      requireInput(guard);
      return clickMac(command.args, guard);
    case "type":
      requireInput(guard);
      await typeText(guard, OWN_PID, command.args.text);
      return { command: "type" };
    case "key":
      requireInput(guard);
      return keyMac(command.args, guard);
    default:
      throw new AxError("unsupported", "That desktop tool is not available on macOS yet.");
  }
}
