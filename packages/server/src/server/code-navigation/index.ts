import type { CodeNavigationResult } from "@pimi/protocol/messages";
import { nameProvider } from "./name-provider.js";
import { isTypeScriptFile, queryTsServer, TsServerUnavailableError } from "./tsserver.js";
import type { CodeNavigationQuery } from "./types.js";

export type { CodeNavigationQuery } from "./types.js";
export { closeAllTsServers, closeTsServer } from "./tsserver.js";

/**
 * TypeScript answers for TS and JS files; name matching answers for everything else, and for TS
 * when tsserver times out or fails. The result says which one answered and why a fallback happened.
 * Rename has no name-based answer, so its failure is the caller's error.
 */
export async function queryCodeNavigation(
  query: CodeNavigationQuery,
  signal: AbortSignal,
): Promise<CodeNavigationResult> {
  if (!isTypeScriptFile(query.path)) return nameProvider(query, signal);
  try {
    return await queryTsServer(query);
  } catch (error) {
    signal.throwIfAborted();
    if (query.kind === "rename") {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        error instanceof TsServerUnavailableError ? `Rename needs TypeScript: ${reason}` : reason,
        { cause: error },
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    const result = await nameProvider(query, signal);
    return { ...result, note: `TypeScript did not answer: ${reason} Showing matches by name.` };
  }
}
