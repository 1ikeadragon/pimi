import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { PIMI_UPDATE_CACHE_DIRECTORY } from "../features/pimi-auto-updater.js";
import { tailFile } from "./tail-file.js";

export interface DesktopUpdaterDiagnosticFile {
  path: string;
  exists: boolean;
  modifiedAt: string | null;
  contents: string;
  error: string | null;
}

export interface DesktopUpdaterDiagnostics {
  platform: NodeJS.Platform;
  currentVersion: string;
  targetVersion: string | null;
  targetVersionError: string | null;
  shipItDirectory: string | null;
  state: DesktopUpdaterDiagnosticFile | null;
  stdout: DesktopUpdaterDiagnosticFile | null;
  stderr: DesktopUpdaterDiagnosticFile | null;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function findLatestInstallerLog(cachePath: string): { path: string; modifiedAt: number } | null {
  let latest: { path: string; modifiedAt: number } | null = null;
  for (const entry of readdirSync(cachePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^download-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
    const file = path.join(cachePath, entry.name, "install.log");
    try {
      const stat = lstatSync(file);
      if (stat.isFile() && (!latest || stat.mtimeMs > latest.modifiedAt)) {
        latest = { path: file, modifiedAt: stat.mtimeMs };
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return latest;
}

function readInstallerLog(cachePath: string): DesktopUpdaterDiagnosticFile | null {
  let latest;
  try {
    latest = findLatestInstallerLog(cachePath);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    return {
      path: cachePath,
      exists: false,
      modifiedAt: null,
      contents: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!latest) return null;
  const file = {
    path: latest.path,
    exists: true,
    modifiedAt: new Date(latest.modifiedAt).toISOString(),
  };
  try {
    return {
      ...file,
      contents: tailFile(latest.path, 100, { throwOnReadError: true }),
      error: null,
    };
  } catch (error) {
    return {
      ...file,
      contents: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getDesktopUpdaterDiagnostics(): DesktopUpdaterDiagnostics {
  const cachePath = path.join(app.getPath("userData"), PIMI_UPDATE_CACHE_DIRECTORY);
  return {
    platform: process.platform,
    currentVersion: app.getVersion(),
    targetVersion: null,
    targetVersionError: null,
    // These field names remain stable for existing diagnostic report callers.
    shipItDirectory: cachePath,
    state: null,
    stdout: readInstallerLog(cachePath),
    stderr: null,
  };
}
