import type { CodeNavigationQueryRequest, CodeNavigationResult } from "@pimi/protocol/messages";

/** A server the user chose for a language, replacing auto-detection. */
export interface LanguageServerOverride {
  language: string;
  command: string;
  args: string[];
}

export type CodeNavigationQuery = Omit<CodeNavigationQueryRequest, "type" | "requestId"> & {
  /** Absolute workspace directory; `path` and every result path are relative to it. */
  cwd: string;
  /** From daemon config; a language without an entry is auto-detected. */
  languageServers?: LanguageServerOverride[];
};

export type CodeNavigationLocation = CodeNavigationResult["results"][number];
export type CodeNavigationEdit = CodeNavigationResult["edits"][number];

/** What a provider returns; the router adds the rename capability. */
export type ProviderResult = Omit<CodeNavigationResult, "renameSupport">;

/** A provider that cannot answer throws; the caller decides whether to fall back. */
export type CodeNavigationProvider = (
  query: CodeNavigationQuery,
  signal: AbortSignal,
) => Promise<ProviderResult>;
