import { app, ipcMain, shell, systemPreferences, desktopCapturer } from "electron";
import {
  DesktopTargetExecuteRequestSchema,
  type DesktopTargetErrorCode,
  type DesktopTargetExecuteResponse,
} from "@pimi/protocol/desktop-target/rpc-schemas";
import { AxError, probeAutomation } from "./mac/ax.js";
import { runMac, screenGranted } from "./mac/index.js";
import { HelperError, stopHelper } from "./helper-process.js";
import { checkWinDataDir, resolveWinScope, runWin } from "./win/index.js";

// Attack's desktop target: one window, chosen by the owner, driven through the platform's
// accessibility API. The guard arrives with every call (the daemon builds it from the run), and
// every call re-resolves the window from it: a closed window or a different title fails the call
// instead of moving to another window. macOS lives in mac/, Windows in win/ (a helper process).

type Payload = DesktopTargetExecuteResponse["payload"];

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

function failure(requestId: string, code: DesktopTargetErrorCode, message: string): Payload {
  return { requestId, ok: false, error: { code, message } };
}

export async function executeDesktopTarget(raw: unknown): Promise<Payload> {
  const requestId =
    typeof (raw as { requestId?: unknown } | null)?.requestId === "string"
      ? (raw as { requestId: string }).requestId
      : "desktop-invalid";
  if (!IS_MAC && !IS_WIN) {
    return failure(
      requestId,
      "unsupported",
      "Desktop targets are only available on macOS and Windows.",
    );
  }
  const parsed = DesktopTargetExecuteRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return failure(
      requestId,
      "refused",
      `Invalid desktop request: ${parsed.error.issues[0]?.message}`,
    );
  }
  const { guard, command, agentId } = parsed.data;
  if (!guard) return failure(requestId, "refused", "A desktop request needs a run guard.");
  if (guard.platform !== process.platform && command.command !== "list_windows") {
    return failure(
      requestId,
      "refused",
      `This run targets a ${guard.platform} window, but this computer runs ${process.platform}.`,
    );
  }
  try {
    const result = IS_MAC
      ? await runMac(command, guard, agentId)
      : await runWin(command, guard, agentId);
    return { requestId, ok: true, result };
  } catch (error) {
    if (error instanceof AxError || error instanceof HelperError) {
      return failure(requestId, error.code, error.message);
    }
    return failure(requestId, "failed", error instanceof Error ? error.message : String(error));
  }
}

const SETTINGS_PANES = {
  accessibility: "Privacy_Accessibility",
  screen: "Privacy_ScreenCapture",
  automation: "Privacy_Automation",
} as const;

export function registerDesktopTargetIpc(): void {
  if (IS_WIN) app.on("before-quit", stopHelper);
  ipcMain.handle("pimi:desktop-target:permissions", async (_event, raw: unknown) => {
    if (IS_WIN) {
      // Windows has no per-app grants for UI Automation or window capture.
      return {
        supported: true,
        platform: "win32",
        accessibility: true,
        screen: "granted",
        automation: "granted",
      };
    }
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
      platform: "darwin",
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
      guard: {
        runId: "owner",
        bundleId: "none",
        windowTitle: "",
        allowInput: false,
        platform: process.platform === "win32" ? "win32" : "darwin",
      },
      command: { command: "list_windows", args: {} },
    });
    return payload.ok && payload.result.command === "list_windows"
      ? { ok: true, windows: payload.result.windows }
      : { ok: false, error: payload.ok ? "unexpected result" : payload.error };
  });
  ipcMain.handle("pimi:desktop-target:execute", (_event, raw: unknown) =>
    executeDesktopTarget(raw),
  );
  // The launch form's data-dir proposal for a picked window, and the check of one the owner typed.
  ipcMain.handle("pimi:desktop-target:scope", async (_event, raw: unknown) => {
    if (!IS_WIN) return { ok: false, error: "Security scope is only available on Windows." };
    const request = raw as {
      bundleId?: unknown;
      windowTitle?: unknown;
      win?: { hwnd?: unknown; pid?: unknown; processStartedAt?: unknown; windowClass?: unknown };
    } | null;
    const win = request?.win;
    if (
      typeof request?.bundleId !== "string" ||
      typeof win?.hwnd !== "string" ||
      typeof win.pid !== "number" ||
      typeof win.windowClass !== "string"
    ) {
      return { ok: false, error: "Pick a window first." };
    }
    try {
      const scope = await resolveWinScope({
        bundleId: request.bundleId,
        windowTitle: typeof request.windowTitle === "string" ? request.windowTitle : "",
        win: {
          hwnd: win.hwnd,
          pid: win.pid,
          processStartedAt: typeof win.processStartedAt === "string" ? win.processStartedAt : null,
          windowClass: win.windowClass,
        },
      });
      return { ok: true, ...scope };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("pimi:desktop-target:check-data-dir", async (_event, raw: unknown) => {
    if (!IS_WIN || typeof raw !== "string") return null;
    return checkWinDataDir(raw);
  });
  ipcMain.handle("pimi:desktop-target:open-settings", async (_event, pane: unknown) => {
    if (!IS_MAC || typeof pane !== "string" || !(pane in SETTINGS_PANES)) return;
    await shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${SETTINGS_PANES[pane as keyof typeof SETTINGS_PANES]}`,
    );
  });
}
