import { systemPreferences } from "electron";
import type {
  DesktopTargetCommand,
  DesktopTargetResult,
} from "@pimi/protocol/desktop-target/rpc-schemas";
import {
  AxError,
  clickElement,
  clickPoint,
  listWindows,
  pressKey,
  resolveWindow,
  snapshotWindow,
  typeText,
} from "./ax.js";
import { captureWindow } from "./capture.js";
import { forbiddenTarget, isElementPath, keyCodeFor, parseChord, refuseChord } from "./guard.js";
import { pointInFrame, type DesktopGuard } from "../guard.js";

// The macOS side of Attack's desktop target: one window, chosen by the owner, driven through
// Accessibility. Every call re-resolves the window from the guard: a closed window or a different
// title fails the call instead of moving to another window.

const OWN_PID = process.pid;

export function screenGranted(): boolean {
  return systemPreferences.getMediaAccessStatus("screen") === "granted";
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
): Promise<DesktopTargetResult> {
  const forbidden = forbiddenTarget(guard.bundleId);
  if (forbidden) throw new AxError("refused", forbidden);
  if (!screenGranted()) {
    throw new AxError(
      "permission_missing",
      "Pimi does not have Screen Recording access, so it cannot identify the target window. Grant it in System Settings > Privacy & Security > Screen Recording.",
    );
  }
  switch (command.command) {
    case "list_windows": {
      const windows = await listWindows(OWN_PID);
      return {
        command: "list_windows",
        windows: windows
          .filter((window) => forbiddenTarget(window.bundleId) === null)
          .map((window) => ({
            bundleId: window.bundleId,
            appName: window.appName,
            windowTitle: window.windowTitle,
            platform: "darwin" as const,
          })),
      };
    }
    case "screenshot": {
      const window = await resolveWindow(guard, OWN_PID);
      if (window.windowNumber === null) {
        throw new AxError("window_gone", "The target window is not on screen.");
      }
      const shot = await captureWindow(window.windowNumber, command.args.maxEdge ?? 1280);
      return {
        command: "screenshot",
        mimeType: "image/png",
        ...shot,
        windowWidth: window.frame.width,
        windowHeight: window.frame.height,
      };
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
