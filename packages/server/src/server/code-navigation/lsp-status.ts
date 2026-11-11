import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute } from "node:path";
import type { LspLanguage, LspLaunchSpec } from "./lsp-servers.js";
import { LSP_LANGUAGES, detectLspServer } from "./lsp-servers.js";
import { LspProcess } from "./lsp-client.js";
import { resolveTsServerPath } from "./tsserver.js";
import type { LanguageServerOverride } from "./types.js";
import { createRequire } from "node:module";
import type { CodeNavigationServerStatus } from "@pimi/protocol/messages";

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CACHE_MS = 60_000;
const MAX_ARGS = 32;

export interface ProbeResult {
  ok: boolean;
  name: string | null;
  version: string | null;
  error: string | null;
}

const probeCache = new Map<string, { at: number; result: ProbeResult }>();

/** Starts the server, waits for `initialize` to answer, and stops it. Nothing is opened in it. */
export async function probeLspServer(
  launch: Pick<LspLaunchSpec, "executable" | "args">,
  options: { fresh: boolean } = { fresh: false },
): Promise<ProbeResult> {
  const key = `${launch.executable}\0${launch.args.join("\0")}`;
  const cached = probeCache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.result;
  let result: ProbeResult;
  let process: LspProcess | null = null;
  try {
    // An empty directory: servers scan their root, and the home directory is not a project.
    process = new LspProcess(tmpdir(), launch, () => undefined);
    await process.whenReady(PROBE_TIMEOUT_MS);
    result = {
      ok: true,
      name: process.serverInfo?.name ?? null,
      version: process.serverInfo?.version ?? null,
      error: null,
    };
  } catch (error) {
    result = {
      ok: false,
      name: null,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    process?.stop();
  }
  probeCache.set(key, { at: Date.now(), result });
  return result;
}

/** A custom server must be an absolute path to an executable file. Throws a user-facing message. */
export async function validateServerPath(command: string): Promise<void> {
  if (command.includes("\0") || !isAbsolute(command)) {
    throw new Error("Use the full path to the server, starting at the root of the disk.");
  }
  let info;
  try {
    info = await stat(command);
  } catch {
    throw new Error("No file exists at that path.");
  }
  if (!info.isFile()) throw new Error("That path is not a file.");
  if (process.platform !== "win32") {
    try {
      await access(command, constants.X_OK);
    } catch {
      throw new Error("That file is not executable.");
    }
  }
}

export async function validateLanguageServerOverrides(
  entries: LanguageServerOverride[] | undefined,
): Promise<void> {
  const seen = new Set<string>();
  for (const entry of entries ?? []) {
    if (!LSP_LANGUAGES.some((language) => language.id === entry.language)) {
      throw new Error(`Unknown language "${entry.language}".`);
    }
    if (seen.has(entry.language)) throw new Error(`${entry.language} is set twice.`);
    seen.add(entry.language);
    if (entry.args.length > MAX_ARGS) throw new Error("Too many arguments.");
    await validateServerPath(entry.command);
  }
}

function typeScriptStatus(): CodeNavigationServerStatus {
  let path: string | null = null;
  let version: string | null = null;
  let error: string | null = null;
  try {
    path = resolveTsServerPath(homedir());
    const packagePath = path.replace(/lib[\\/]tsserver\.js$/, "package.json");
    version = (createRequire(import.meta.url)(packagePath) as { version?: string }).version ?? null;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    language: "typescript",
    label: "TypeScript and JavaScript",
    extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
    source: "bundled",
    name: "TypeScript",
    path,
    version,
    status: path ? "found" : "failed",
    error,
    installHint: null,
    custom: null,
  };
}

async function languageStatus(
  language: LspLanguage,
  overrides: LanguageServerOverride[],
): Promise<CodeNavigationServerStatus> {
  const custom = overrides.find((entry) => entry.language === language.id) ?? null;
  const base = {
    language: language.id,
    label: language.label,
    extensions: language.extensions,
    installHint: language.installHint,
    custom: custom ? { command: custom.command, args: custom.args } : null,
  };
  let launch: LspLaunchSpec | null;
  if (custom) {
    try {
      await validateServerPath(custom.command);
    } catch (cause) {
      return {
        ...base,
        source: "custom",
        name: basename(custom.command),
        path: custom.command,
        version: null,
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    launch = {
      name: basename(custom.command),
      executable: custom.command,
      args: custom.args,
      source: "custom",
    };
  } else {
    launch = await detectLspServer(language);
  }
  if (!launch) {
    return {
      ...base,
      source: "auto",
      name: null,
      path: null,
      version: null,
      status: "not_found",
      error: null,
    };
  }
  const probe = await probeLspServer(launch);
  return {
    ...base,
    source: launch.source,
    name: probe.name ?? launch.name,
    path: launch.executable,
    version: probe.version,
    status: probe.ok ? "found" : "failed",
    error: probe.error,
  };
}

export async function listLanguageServers(
  overrides: LanguageServerOverride[],
): Promise<CodeNavigationServerStatus[]> {
  const others = await Promise.all(
    LSP_LANGUAGES.map((language) => languageStatus(language, overrides)),
  );
  return [typeScriptStatus(), ...others];
}

/** Starts the server for `languageId`: the given command, else the one that would be used now. */
export async function testLanguageServer(
  languageId: string,
  command: string | undefined,
  args: string[],
  overrides: LanguageServerOverride[],
): Promise<ProbeResult> {
  const language = LSP_LANGUAGES.find((entry) => entry.id === languageId);
  if (!language)
    return { ok: false, name: null, version: null, error: `Unknown language "${languageId}".` };
  let launch: Pick<LspLaunchSpec, "executable" | "args"> | null;
  if (command !== undefined) {
    try {
      await validateServerPath(command);
    } catch (cause) {
      return {
        ok: false,
        name: null,
        version: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    launch = { executable: command, args };
  } else {
    const custom = overrides.find((entry) => entry.language === languageId);
    launch = custom
      ? { executable: custom.command, args: custom.args }
      : await detectLspServer(language);
  }
  if (!launch) {
    return { ok: false, name: null, version: null, error: "No server was found on this host." };
  }
  return probeLspServer(launch, { fresh: true });
}
