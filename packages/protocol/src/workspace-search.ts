import { z } from "zod";

// Project text search (`workspace.search.*`). The daemon streams matches from `git grep`; the app
// and the daemon read these caps from here so the UI can name the limit that stopped a search.
// `run` is a finite stream: `.update` messages carry matches, the terminal `.response` carries the
// request-level error and the stats. `.update` messages for one `requestId` can repeat a file.
export const WORKSPACE_SEARCH_LIMITS = {
  maxMatches: 20_000,
  maxFiles: 2_000,
  timeoutMs: 60_000,
  maxQueryLength: 1_000,
  maxGlobs: 32,
  maxGlobLength: 256,
  maxReplaceFiles: 500,
  /** Replace reads and rewrites a file through the editor's write path, which has this cap. */
  maxReplaceFileBytes: 1024 * 1024,
  maxPreviewChars: 250,
} as const;

const WorkspaceSearchQueryFields = {
  workspaceId: z.string().trim().min(1).max(256),
  query: z.string().min(1).max(WORKSPACE_SEARCH_LIMITS.maxQueryLength),
  isRegex: z.boolean(),
  matchCase: z.boolean(),
  wholeWord: z.boolean(),
};

const WorkspaceSearchGlobsSchema = z
  .array(z.string().max(WORKSPACE_SEARCH_LIMITS.maxGlobLength))
  .max(WORKSPACE_SEARCH_LIMITS.maxGlobs);

export const WorkspaceSearchRunRequestSchema = z.object({
  type: z.literal("workspace.search.run.request"),
  ...WorkspaceSearchQueryFields,
  include: WorkspaceSearchGlobsSchema,
  exclude: WorkspaceSearchGlobsSchema,
  // false also searches files that .gitignore and the other ignore files exclude.
  useIgnoreFiles: z.boolean(),
  requestId: z.string(),
});

export const WorkspaceSearchCancelRequestSchema = z.object({
  type: z.literal("workspace.search.cancel.request"),
  targetRequestId: z.string(),
  requestId: z.string(),
});

const WorkspaceSearchReplaceFileSchema = z.object({
  path: z.string().min(1).max(4096),
  // Matches the search found in this file. The daemon skips the file when it finds a different count.
  expectedMatches: z.number().int().positive(),
  // Dismissed matches: 1-based line and 0-based UTF-16 column of the match start in that line.
  skip: z.array(z.object({ line: z.number().int().positive(), column: z.number().int().min(0) })),
});

export const WorkspaceSearchReplaceRequestSchema = z.object({
  type: z.literal("workspace.search.replace.request"),
  ...WorkspaceSearchQueryFields,
  replacement: z.string().max(WORKSPACE_SEARCH_LIMITS.maxQueryLength * 10),
  files: z
    .array(WorkspaceSearchReplaceFileSchema)
    .min(1)
    .max(WORKSPACE_SEARCH_LIMITS.maxReplaceFiles),
  requestId: z.string(),
});

const WorkspaceSearchMatchSchema = z.object({
  line: z.number().int().positive(),
  // A window of the line, at most WORKSPACE_SEARCH_LIMITS.maxPreviewChars long, that starts at
  // `previewOffset` UTF-16 units into the full line.
  preview: z.string(),
  previewOffset: z.number().int().min(0),
  // Match spans inside `preview`, [start, end) in UTF-16 units. Empty when the daemon could not
  // locate the match in the line; the row then marks the whole preview.
  ranges: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])),
});

export const WorkspaceSearchRunUpdateMessageSchema = z.object({
  type: z.literal("workspace.search.run.update"),
  payload: z.object({
    requestId: z.string(),
    files: z.array(z.object({ path: z.string(), matches: z.array(WorkspaceSearchMatchSchema) })),
  }),
});

const WorkspaceSearchStatsSchema = z.object({
  files: z.number().int().min(0),
  // Occurrences, so a line with two hits counts twice.
  matches: z.number().int().min(0),
  unlocated: z.number().int().min(0),
  elapsedMs: z.number().min(0),
  // The cap that ended the search early; null when it ran to the end.
  limitHit: z.enum(["matches", "files", "time"]).nullable(),
  cancelled: z.boolean(),
  // "basic" means this Git has no PCRE and the pattern was read as a POSIX extended expression.
  regexDialect: z.enum(["pcre", "basic"]).nullable(),
});

export const WorkspaceSearchRunResponseMessageSchema = z.object({
  type: z.literal("workspace.search.run.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
    stats: WorkspaceSearchStatsSchema.nullable(),
  }),
});

export const WorkspaceSearchCancelResponseMessageSchema = z.object({
  type: z.literal("workspace.search.cancel.response"),
  payload: z.object({ requestId: z.string(), cancelled: z.boolean() }),
});

const WorkspaceSearchReplaceFileResultSchema = z.object({
  path: z.string(),
  replacements: z.number().int().min(0),
  // Why the file was left untouched; null when it was rewritten.
  skippedReason: z.string().nullable(),
});

export const WorkspaceSearchReplaceUpdateMessageSchema = z.object({
  type: z.literal("workspace.search.replace.update"),
  payload: z.object({ requestId: z.string(), result: WorkspaceSearchReplaceFileResultSchema }),
});

export const WorkspaceSearchReplaceResponseMessageSchema = z.object({
  type: z.literal("workspace.search.replace.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
    filesChanged: z.number().int().min(0),
    replacements: z.number().int().min(0),
  }),
});

export type WorkspaceSearchRunRequest = z.infer<typeof WorkspaceSearchRunRequestSchema>;
export type WorkspaceSearchReplaceRequest = z.infer<typeof WorkspaceSearchReplaceRequestSchema>;
export type WorkspaceSearchCancelRequest = z.infer<typeof WorkspaceSearchCancelRequestSchema>;
export type WorkspaceSearchMatch = z.infer<typeof WorkspaceSearchMatchSchema>;
export type WorkspaceSearchFileMatches = z.infer<
  typeof WorkspaceSearchRunUpdateMessageSchema
>["payload"]["files"][number];
export type WorkspaceSearchStats = z.infer<typeof WorkspaceSearchStatsSchema>;
export type WorkspaceSearchRunResponse = z.infer<
  typeof WorkspaceSearchRunResponseMessageSchema
>["payload"];
export type WorkspaceSearchReplaceFileResult = z.infer<
  typeof WorkspaceSearchReplaceFileResultSchema
>;
export type WorkspaceSearchReplaceResponse = z.infer<
  typeof WorkspaceSearchReplaceResponseMessageSchema
>["payload"];
