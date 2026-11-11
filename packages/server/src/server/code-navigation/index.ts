import type { CodeNavigationResult } from "@pimi/protocol/messages";
import { closeAllLsp, closeLspForWorkspace, queryLsp } from "./lsp-provider.js";
import { lspLanguageForPath, renameHint, resolveLspLaunch } from "./lsp-servers.js";
import { nameProvider } from "./name-provider.js";
import { isTypeScriptFile, queryTsServer } from "./tsserver.js";
import type { CodeNavigationQuery, ProviderResult } from "./types.js";
import { closeAllTsServers, closeTsServer } from "./tsserver.js";

export type { CodeNavigationQuery, LanguageServerOverride } from "./types.js";

export function closeCodeNavigationWorkspace(workspaceId: string): void {
  closeTsServer(workspaceId);
  closeLspForWorkspace(workspaceId);
}

export function closeAllCodeNavigation(): void {
  closeAllTsServers();
  closeAllLsp();
}

type RenameSupport = CodeNavigationResult["renameSupport"];

async function renameSupportFor(query: CodeNavigationQuery): Promise<RenameSupport> {
  if (isTypeScriptFile(query.path)) {
    return {
      available: true,
      tooltip: null,
      language: { id: "typescript", label: "TypeScript", serverFound: true },
    };
  }
  const language = lspLanguageForPath(query.path);
  if (!language) return { available: false, tooltip: null, language: null };
  const launch = await resolveLspLaunch(language, query.languageServers);
  const label = language.id.charAt(0).toUpperCase() + language.id.slice(1);
  return launch
    ? { available: true, tooltip: null, language: { id: language.id, label, serverFound: true } }
    : {
        available: false,
        tooltip: renameHint(language),
        language: { id: language.id, label, serverFound: false },
      };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A language server answers when one is available for the file: TypeScript for TS and JS, or an
 * installed server for Python, PHP, Rust and Go. Name matching answers for everything else, and
 * when the server times out or fails; the result says which one answered and why a fallback
 * happened. Rename has no name-based answer, so its failure is the caller's error.
 */
async function route(query: CodeNavigationQuery, signal: AbortSignal): Promise<ProviderResult> {
  const language = isTypeScriptFile(query.path) ? null : lspLanguageForPath(query.path);
  const launch = language ? await resolveLspLaunch(language, query.languageServers) : null;
  if (!isTypeScriptFile(query.path) && !(language && launch)) {
    if (query.kind === "rename") {
      const hint = language ? renameHint(language) : "Rename is not available for this file type.";
      throw new Error(hint);
    }
    return nameProvider(query, signal);
  }
  try {
    return language && launch
      ? await queryLsp(query, language, launch)
      : await queryTsServer(query);
  } catch (error) {
    signal.throwIfAborted();
    const reason = describe(error);
    if (query.kind === "rename") {
      const needs = language && launch ? launch.name : "TypeScript";
      throw new Error(`Rename needs ${needs}: ${reason}`, { cause: error });
    }
    const result = await nameProvider(query, signal);
    const who = language && launch ? launch.name : "TypeScript";
    return { ...result, note: `${who} did not answer: ${reason} Showing matches by name.` };
  }
}

export async function queryCodeNavigation(
  query: CodeNavigationQuery,
  signal: AbortSignal,
): Promise<CodeNavigationResult> {
  const renameSupport = await renameSupportFor(query);
  if (query.kind === "capabilities") {
    return {
      provider: "name",
      serverName: null,
      note: null,
      results: [],
      truncated: false,
      edits: [],
      renameSupport,
    };
  }
  return { ...(await route(query, signal)), renameSupport };
}
