import type { AttackDesktopTarget } from "@pimi/protocol/attack/types";
import type { DesktopTargetWindow } from "@/desktop/host";

// Windows exe names (DESIGN 7.1 warn tier): browsers, mail and chat, and game launchers. They hold
// signed-in sessions, so the owner gets an extra line before consenting to input.
const WARN_EXE_NAMES: ReadonlySet<string> = new Set([
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe",
  "vivaldi.exe",
  "arc.exe",
  "outlook.exe",
  "olk.exe",
  "thunderbird.exe",
  "teams.exe",
  "ms-teams.exe",
  "slack.exe",
  "discord.exe",
  "steam.exe",
  "steamwebhelper.exe",
  "epicgameslauncher.exe",
  "epicwebhelper.exe",
  "battle.net.exe",
  "eadesktop.exe",
  "origin.exe",
  "ubisoftconnect.exe",
  "upc.exe",
  "galaxyclient.exe",
  "riotclientservices.exe",
]);

// macOS bundle ids, compared lowercased and by prefix so channels like Chrome Canary match.
const WARN_BUNDLE_PREFIXES: readonly string[] = [
  "com.google.chrome",
  "com.apple.safari",
  "org.mozilla.firefox",
  "com.microsoft.edgemac",
  "com.brave.browser",
  "com.operasoftware.opera",
  "com.vivaldi.vivaldi",
  "company.thebrowser.browser",
  "com.microsoft.outlook",
  "com.apple.mail",
  "org.mozilla.thunderbird",
  "com.microsoft.teams",
  "com.tinyspeck.slackmacgap",
  "com.hnc.discord",
  "com.valvesoftware.steam",
  "com.epicgames.epicgameslauncher",
];

export const NO_DESKTOP_WINDOW: AttackDesktopTarget = {
  bundleId: "",
  appName: "",
  windowTitle: "",
  platform: "darwin",
  win: null,
  dataDirs: [],
  launchArgs: "",
  allowRelaunch: false,
  allowDesktopInspect: false,
};

/** The window as the run's target: only the fields the schema carries, never picker-only flags. */
export function toDesktopTarget(window: DesktopTargetWindow): AttackDesktopTarget {
  return {
    bundleId: window.bundleId,
    appName: window.appName,
    windowTitle: window.windowTitle,
    platform: window.platform ?? "darwin",
    win: window.win ?? null,
    // Filled in by the launch form once the owner has picked the window.
    dataDirs: [],
    launchArgs: "",
    allowRelaunch: false,
    allowDesktopInspect: false,
  };
}

export function isWindowsTarget(target: Pick<AttackDesktopTarget, "platform">): boolean {
  return target.platform === "win32";
}

/** A browser, mail or chat client, or a launcher: legitimate, but signed in to the owner's accounts. */
export function isWarnTierTarget(target: AttackDesktopTarget): boolean {
  if (isWindowsTarget(target)) {
    return target.win !== null && WARN_EXE_NAMES.has(target.win.exeName.toLowerCase());
  }
  const bundle = target.bundleId.toLowerCase();
  return WARN_BUNDLE_PREFIXES.some((prefix) => bundle.startsWith(prefix));
}

export type DesktopBlockedReason = "elevated";

export function desktopBlockedReason(window: DesktopTargetWindow): DesktopBlockedReason | null {
  if (window.elevated) return "elevated";
  return null;
}

/** The same window across two listings: the HWND on Windows, app and title on macOS. */
export function sameDesktopWindow(a: DesktopWindowIdentity, b: DesktopWindowIdentity): boolean {
  if (a.win && b.win) return a.win.hwnd === b.win.hwnd;
  return a.bundleId === b.bundleId && a.windowTitle === b.windowTitle;
}

interface DesktopWindowIdentity {
  bundleId: string;
  windowTitle: string;
  win?: { hwnd: string } | null;
}

export function desktopWindowKey(window: DesktopWindowIdentity): string {
  return window.win ? `win:${window.win.hwnd}` : `${window.bundleId}\u0000${window.windowTitle}`;
}
