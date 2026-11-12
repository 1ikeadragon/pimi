import { ipcMain, shell, systemPreferences, desktopCapturer } from "electron";
import {
  DesktopTargetExecuteRequestSchema,
  type DesktopTargetCommand,
  type DesktopTargetExecuteResponse,
  type DesktopTargetResult,
} from "@pimi/protocol/desktop-target/rpc-schemas";
import {
  AxError,
  clickElement,
  clickPoint,
  listWindows,
  pressKey,
  probeAutomation,
  resolveWindow,
  snapshotWindow,
  typeText,
  type AxErrorCode,
} from "./ax.js";
import { captureWindow } from "./capture.js";
import {
  forbiddenTarget,
  isElementPath,
  keyCodeFor,
  parseChord,
  pointInFrame,
  refuseChord,
  type DesktopGuard,
} from "./guard.js";

// Attack's desktop target: one window, chosen by the owner, driven through Accessibility. The
// guard arrives with every call (the daemon builds it from the run), and every call re-resolves
// the window from it: a closed window or a different title fails the call instead of moving to
// another window.

type Payload = DesktopTargetExecuteResponse["payload"];

const IS_MAC = process.platform === "darwin";
const OWN_PID = process.pid;

function failure(requestId: string, code: AxErrorCode, message: string): Payload {
  return { requestId, ok: false, error: { code, message } };
}

function screenGranted(): boolean {
  return systemPreferences.getMediaAccessStatus("screen") === "granted";
}

async function run(
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
        windows: windows.filter((window) => forbiddenTarget(window.bundleId) === null),
      };
    }
    case "screenshot": {
      const window = await resolveWindow(guard, OWN_PID);
      if (window.windowNumber === null) {
        throw new AxError("window_gone", "The target window is not on screen.");
      }
      const shot = await captureWindow(window.windowNumber, command.args.maxWidth ?? 1280);
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
    case "click": {
      requireInput(guard);
      const { element, point } = command.args;
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
    case "type": {
      requireInput(guard);
      await typeText(guard, OWN_PID, command.args.text);
      return { command: "type" };
    }
    case "key": {
      requireInput(guard);
      const chord = parseChord(command.args.chord);
      if (!chord.ok) throw new AxError("refused", chord.message);
      const refused = refuseChord(chord);
      if (refused) throw new AxError("refused", refused);
      const code = keyCodeFor(chord.key);
      await pressKey(
        guard,
        OWN_PID,
        code !== null ? { code } : { char: chord.key },
        chord.modifiers,
      );
      return { command: "key" };
    }
  }
}

function requireInput(guard: DesktopGuard): void {
  if (!guard.allowInput) {
    throw new AxError("refused", "The owner did not allow desktop input for this run.");
  }
}

export async function executeDesktopTarget(raw: unknown): Promise<Payload> {
  const requestId =
    typeof (raw as { requestId?: unknown } | null)?.requestId === "string"
      ? (raw as { requestId: string }).requestId
      : "desktop-invalid";
  if (!IS_MAC) {
    return failure(requestId, "unsupported", "Desktop targets are only available on macOS.");
  }
  const parsed = DesktopTargetExecuteRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return failure(
      requestId,
      "refused",
      `Invalid desktop request: ${parsed.error.issues[0]?.message}`,
    );
  }
  const { guard, command } = parsed.data;
  if (!guard) return failure(requestId, "refused", "A desktop request needs a run guard.");
  try {
    const result = await run(command, guard);
    return { requestId, ok: true, result };
  } catch (error) {
    if (error instanceof AxError) return failure(requestId, error.code, error.message);
    return failure(requestId, "failed", error instanceof Error ? error.message : String(error));
  }
}

const SETTINGS_PANES = {
  accessibility: "Privacy_Accessibility",
  screen: "Privacy_ScreenCapture",
  automation: "Privacy_Automation",
} as const;

export function registerDesktopTargetIpc(): void {
  ipcMain.handle("pimi:desktop-target:permissions", async (_event, raw: unknown) => {
    if (!IS_MAC) return { supported: false };
    const prompt = (raw as { prompt?: unknown } | null)?.prompt === true;
    let automation: "unknown" | "granted" | "denied" | "failed" = "unknown";
    if (prompt) {
      systemPreferences.isTrustedAccessibilityClient(true);
      if (!screenGranted()) {
        // Asking for window sources is what makes macOS show the Screen Recording prompt.
        await desktopCapturer
          .getSources({ types: ["window"], thumbnailSize: { width: 1, height: 1 } })
          .catch(() => undefined);
      }
      automation = await probeAutomation();
    }
    return {
      supported: true,
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screen: systemPreferences.getMediaAccessStatus("screen"),
      automation,
    };
  });
  ipcMain.handle("pimi:desktop-target:list-windows", async () => {
    const payload = await executeDesktopTarget({
      type: "desktop.target.execute.request",
      requestId: "list",
      agentId: "owner",
      // Listing names no window; the guard is only a placeholder the schema requires.
      guard: { runId: "owner", bundleId: "none", windowTitle: "", allowInput: false },
      command: { command: "list_windows", args: {} },
    });
    return payload.ok && payload.result.command === "list_windows"
      ? { ok: true, windows: payload.result.windows }
      : { ok: false, error: payload.ok ? "unexpected result" : payload.error };
  });
  ipcMain.handle("pimi:desktop-target:execute", (_event, raw: unknown) =>
    executeDesktopTarget(raw),
  );
  ipcMain.handle("pimi:desktop-target:open-settings", async (_event, pane: unknown) => {
    if (!IS_MAC || typeof pane !== "string" || !(pane in SETTINGS_PANES)) return;
    await shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${SETTINGS_PANES[pane as keyof typeof SETTINGS_PANES]}`,
    );
  });
}
