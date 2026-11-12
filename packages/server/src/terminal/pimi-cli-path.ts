import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";

// Where the Pimi CLI lives, for the PATH entry and PIMI_HOOK_CLI every terminal gets. Kept
// apart from terminal.ts so the daemon can resolve it without loading node-pty.

const require = createRequire(import.meta.url);
const PIMI_CLI_BIN_ENTRY = "@pimi/cli/bin/pimi";

export function resolveExternalProcessPath(filePath: string): string {
  return filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

export function resolvePimiCliBinDir(): string | null {
  const cliExecutable = resolvePimiCliExecutablePath();
  return cliExecutable ? dirname(cliExecutable) : null;
}

export function resolvePimiCliExecutablePath(): string | null {
  const configuredCli = process.env.PIMI_CLI?.trim();
  if (configuredCli) {
    return resolvePath(configuredCli);
  }

  const cliEntrypoint = resolvePimiCliBinEntrypoint();
  if (!cliEntrypoint) {
    return null;
  }

  const externalCliEntrypoint = resolveExternalProcessPath(cliEntrypoint);
  const npmBinDir = findNpmBinDir(dirname(externalCliEntrypoint));
  if (npmBinDir) {
    const shim = resolvePimiCliShim(npmBinDir);
    if (shim) {
      return shim;
    }
  }

  return externalCliEntrypoint;
}

function resolvePimiCliBinEntrypoint(): string | null {
  try {
    return require.resolve(PIMI_CLI_BIN_ENTRY);
  } catch {
    return null;
  }
}

function findNpmBinDir(startPath: string): string | null {
  let current = startPath;
  while (true) {
    const candidate = join(current, "node_modules", ".bin");
    if (hasPimiCliShim(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function hasPimiCliShim(binDir: string): boolean {
  return resolvePimiCliShim(binDir) !== null;
}

function resolvePimiCliShim(binDir: string): string | null {
  for (const name of pimiCliShimNames()) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function pimiCliShimNames(): string[] {
  return process.platform === "win32" ? ["pimi.cmd", "pimi.exe", "pimi"] : ["pimi"];
}
