import { execFile, spawn } from "node:child_process";
import { lstat, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app, autoUpdater, shell } from "electron";
import log from "electron-log/main";
import type { AppUpdateCheckResult, AppUpdateInstallResult } from "./app-update-service.js";
import type { AppUpdateCheckIntent } from "./app-update-rollout.js";
import {
  canReplacePimiBundle,
  discardStagedMacUpdate,
  quarantinePimiDownload,
  stagePimiMacUpdate,
  startStagedMacUpdate,
} from "./pimi-mac-install.js";
import {
  checkPimiRelease,
  downloadPimiInstaller,
  pimiUpdateAssetName,
  verifyPimiInstaller,
  type PimiUpdateRelease,
} from "./pimi-update-release.js";

const run = promisify(execFile);
const RELEASE_CHECK_CACHE_MS = 30_000;
const DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60_000;

interface Download {
  release: PimiUpdateRelease;
  pending: Promise<string>;
  ready: boolean;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(currentVersion: string): AppUpdateCheckResult {
  return {
    currentVersion,
    latestVersion: currentVersion,
    hasUpdate: false,
    readyToInstall: false,
    body: null,
    date: null,
    errorMessage: null,
  };
}

function sameRelease(first: PimiUpdateRelease, second: PimiUpdateRelease): boolean {
  return first.version === second.version && first.digest === second.digest;
}

async function removeExpiredDownloads(cache: string): Promise<void> {
  for (const entry of await readdir(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^download-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
    const directory = path.join(cache, entry.name);
    const directoryStat = await lstat(directory);
    if (
      !directoryStat.isDirectory() ||
      Date.now() - directoryStat.mtimeMs < DOWNLOAD_RETENTION_MS
    ) {
      continue;
    }
    // A detach failure can leave a read-only disk image mounted here. Remove
    // only known files and the empty directory, never recurse through a mount.
    for (const file of ["Pimi-macOS-arm64.dmg", "Pimi-Windows-x64.exe", "install.log"]) {
      await rm(path.join(directory, file), { force: true });
    }
    await rmdir(directory).catch(() => undefined);
  }
}

async function verifyWindowsPublisher(installer: string, signal?: AbortSignal): Promise<void> {
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = `
    $ErrorActionPreference = 'Stop'
    $installed = Get-AuthenticodeSignature -LiteralPath $env:PIMI_INSTALLED_EXE
    $candidate = Get-AuthenticodeSignature -LiteralPath $env:PIMI_UPDATE_EXE
    if ($installed.Status -eq 'Valid') {
      if ($candidate.Status -ne 'Valid' -or
          $candidate.SignerCertificate.Thumbprint -ne $installed.SignerCertificate.Thumbprint) {
        exit 1
      }
    } elseif ($installed.Status -ne 'NotSigned' -or
              $candidate.Status -notin @('Valid', 'NotSigned')) {
      exit 1
    }
  `;
  await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, PIMI_INSTALLED_EXE: app.getPath("exe"), PIMI_UPDATE_EXE: installer },
    windowsHide: true,
    timeout: 10_000,
    signal,
  }).catch((error) => {
    if (signal?.aborted) throw error;
    throw new Error("Windows could not verify the Pimi installer’s signing identity.");
  });
}

async function startWindowsInstaller(
  installer: string,
  restart: boolean,
  signal?: AbortSignal,
): Promise<void> {
  // Preserve the downloaded-file marker. Signed existing installs additionally
  // require Authenticode continuity through verifyWindowsPublisher.
  await writeFile(`${installer}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n", { signal });
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(installer, ["--updated", "/S", ...(restart ? ["--force-run"] : [])], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class PimiAutoUpdater {
  private downloaded: Download | null = null;
  private releaseCache: { release: PimiUpdateRelease | null; checkedAt: number } | null = null;
  private checkInProgress: Promise<PimiUpdateRelease | null> | null = null;
  private installInProgress = false;
  private cleanedCache = false;

  private async latest(
    currentVersion: string,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<PimiUpdateRelease | null> {
    const fileName = pimiUpdateAssetName(process.platform, process.arch);
    if (!app.isPackaged || !fileName) return null;
    if (
      !force &&
      this.releaseCache &&
      Date.now() - this.releaseCache.checkedAt < RELEASE_CHECK_CACHE_MS
    ) {
      return this.releaseCache.release;
    }
    // A quit request must have its own deadline even when a renderer check is in flight.
    if (signal) return checkPimiRelease(fileName, currentVersion, signal);
    if (this.checkInProgress) return this.checkInProgress;

    const check = checkPimiRelease(fileName, currentVersion);
    this.checkInProgress = check;
    try {
      const release = await check;
      this.releaseCache = { release, checkedAt: Date.now() };
      return release;
    } finally {
      this.checkInProgress = null;
    }
  }

  private download(release: PimiUpdateRelease, retry: boolean): Download {
    const previous = this.downloaded;
    if (previous && sameRelease(previous.release, release) && !(retry && previous.error)) {
      return previous;
    }
    const cache = path.join(app.getPath("userData"), "pimi-updates");
    if (!this.cleanedCache) {
      this.cleanedCache = true;
      void removeExpiredDownloads(cache).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") log.warn("[pimi-updater] Could not clean update cache", error);
      });
    }

    const record: Download = {
      release,
      pending: downloadPimiInstaller(release, cache).then(async (installer) => {
        if (process.platform === "win32") {
          try {
            await verifyWindowsPublisher(installer);
          } catch (error) {
            await rm(path.dirname(installer), { recursive: true, force: true });
            throw error;
          }
        }
        return installer;
      }),
      ready: false,
      error: null,
    };
    this.downloaded = record;
    void record.pending.then(
      () => {
        record.ready = true;
        return undefined;
      },
      (error: unknown) => {
        record.error = errorMessage(error);
        log.warn("[pimi-updater] Could not download release", record.error);
      },
    );
    return record;
  }

  async check(currentVersion: string, intent: AppUpdateCheckIntent): Promise<AppUpdateCheckResult> {
    const base = emptyResult(currentVersion);
    try {
      const release = await this.latest(currentVersion, intent === "manual");
      if (!release) return base;

      // Check on macOS without prefetching a full disk image on every launch.
      // The explicit Install action downloads it before stopping the daemon.
      const download =
        process.platform === "win32" ? this.download(release, intent === "manual") : null;
      return {
        ...base,
        latestVersion: release.version,
        hasUpdate: true,
        readyToInstall: download?.ready ?? true,
        body: release.notes,
        date: release.publishedAt,
        errorMessage: download?.error ?? null,
        ...(process.platform === "darwin" &&
          !(await canReplacePimiBundle(app.getPath("exe"))) && { manualInstall: true }),
      };
    } catch (error) {
      return { ...base, errorMessage: errorMessage(error) };
    }
  }

  async install(
    currentVersion: string,
    onBeforeQuit?: () => Promise<void>,
  ): Promise<AppUpdateInstallResult> {
    if (this.installInProgress) throw new Error("A Pimi update is already in progress.");
    this.installInProgress = true;
    let handoff = false;
    try {
      const release = await this.latest(currentVersion, true);
      if (!release)
        return { installed: false, version: currentVersion, message: "No update available." };
      const download = this.download(release, true);
      const installer = await download.pending;
      try {
        await verifyPimiInstaller(release, installer);
      } catch (error) {
        if (this.downloaded === download) this.downloaded = null;
        throw error;
      }

      if (process.platform === "darwin") {
        await quarantinePimiDownload(installer);
        const staged = await stagePimiMacUpdate(installer, app.getPath("exe"), release.version);
        if (!staged) {
          const error = await shell.openPath(installer);
          if (error) throw new Error("Pimi could not open the verified disk image.");
          return {
            installed: false,
            openedInstaller: true,
            version: currentVersion,
            message: "Disk image opened. Quit Pimi, then drag the new app into Applications.",
          };
        }
        try {
          await onBeforeQuit?.();
          await startStagedMacUpdate(staged);
        } catch (error) {
          await discardStagedMacUpdate(staged);
          throw error;
        }
      } else {
        await onBeforeQuit?.();
        await startWindowsInstaller(installer, true);
      }
      handoff = true;
      this.quitForUpdate();
      return {
        installed: true,
        version: release.version,
        message: "Pimi is restarting to install the update.",
      };
    } finally {
      if (!handoff) this.installInProgress = false;
    }
  }

  async installOnQuit(currentVersion: string, signal: AbortSignal): Promise<boolean> {
    // Mac replacement asks LaunchServices to open and assess the new app after
    // quitting. An ordinary Quit should not reopen Pimi or trigger that prompt.
    const ready = this.downloaded;
    if (process.platform !== "win32" || this.installInProgress || !ready?.ready) return false;
    this.installInProgress = true;
    let handoff = false;
    try {
      const release = await this.latest(currentVersion, true, signal);
      if (!release || !sameRelease(release, ready.release) || signal.aborted) return false;
      const installer = await ready.pending;
      await verifyPimiInstaller(release, installer, signal);
      if (signal.aborted) return false;
      await startWindowsInstaller(installer, false, signal);
      handoff = true;
      this.quitForUpdate();
      return true;
    } finally {
      if (!handoff) this.installInProgress = false;
    }
  }

  private quitForUpdate(): void {
    setImmediate(() => {
      // Match electron-updater’s handoff so the desktop’s existing quit
      // lifecycle does not run another update check or interrupt installation.
      autoUpdater.emit("before-quit-for-update");
      app.quit();
    });
  }
}
