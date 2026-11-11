import type { CodeNavigationResult } from "@pimi/protocol/messages";
import { nameProvider } from "./name-provider.js";
import type { CodeNavigationQuery } from "./types.js";

export type { CodeNavigationQuery } from "./types.js";

export async function queryCodeNavigation(
  query: CodeNavigationQuery,
  signal: AbortSignal,
): Promise<CodeNavigationResult> {
  return nameProvider(query, signal);
}
