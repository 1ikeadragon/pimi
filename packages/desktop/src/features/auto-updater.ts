import log from "electron-log/main";
import {
  PimiAutoUpdater,
  type AppUpdateCheckIntent,
  type AppUpdateCheckResult,
  type AppUpdateInstallResult,
} from "./pimi-auto-updater.js";

export type { AppUpdateCheckIntent, AppUpdateCheckResult, AppUpdateInstallResult };

export type AppReleaseChannel = "stable" | "beta";

const updater = new PimiAutoUpdater();

export async function checkForAppUpdate({
  currentVersion,
  releaseChannel,
  intent,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}): Promise<AppUpdateCheckResult> {
  const context = { currentVersion, releaseChannel, intent };
  log.info("[auto-updater] check started", context);
  const result = await updater.check(currentVersion, intent);
  log.info("[auto-updater] check completed", {
    ...context,
    targetVersion: result.latestVersion,
    hasUpdate: result.hasUpdate,
    readyToInstall: result.readyToInstall,
    errorMessage: result.errorMessage,
  });
  return result;
}

export function downloadAndInstallUpdate(
  { currentVersion }: { currentVersion: string; releaseChannel: AppReleaseChannel },
  onBeforeQuit?: () => Promise<void>,
): Promise<AppUpdateInstallResult> {
  return updater.install(currentVersion, onBeforeQuit);
}

export async function installAppUpdateOnQuit({
  currentVersion,
  signal,
  onBeforeInstall,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  signal: AbortSignal;
  onBeforeInstall?: () => Promise<void>;
}): Promise<boolean> {
  return updater.installOnQuit(currentVersion, signal, onBeforeInstall);
}
