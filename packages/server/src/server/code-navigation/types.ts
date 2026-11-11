import type { CodeNavigationQueryRequest, CodeNavigationResult } from "@pimi/protocol/messages";

export type CodeNavigationQuery = Omit<CodeNavigationQueryRequest, "type" | "requestId"> & {
  /** Absolute workspace directory; `path` and every result path are relative to it. */
  cwd: string;
};

export type CodeNavigationLocation = CodeNavigationResult["results"][number];
export type CodeNavigationEdit = CodeNavigationResult["edits"][number];

/** A provider that cannot answer throws; the caller decides whether to fall back. */
export type CodeNavigationProvider = (
  query: CodeNavigationQuery,
  signal: AbortSignal,
) => Promise<CodeNavigationResult>;
