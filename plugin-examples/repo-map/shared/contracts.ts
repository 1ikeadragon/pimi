import { defineRpc, defineSubscription } from "@pimi/plugin";
import { z } from "zod";

export const MAX_FILES = 50_000;

export const FileEntrySchema = z.object({
  path: z.string(),
  bytes: z.number(),
  /** Unix seconds of the newest of the last 500 commits that touched the file, else null. */
  lastCommitAt: z.number().nullable(),
});

export type FileEntry = z.infer<typeof FileEntrySchema>;

export const ScanSchema = z.object({
  files: z.array(FileEntrySchema),
  /** True when the repository has more than MAX_FILES tracked files; `files` holds the first MAX_FILES. */
  truncated: z.boolean(),
  total: z.number(),
  head: z.string().nullable(),
});

export type Scan = z.infer<typeof ScanSchema>;

export const scan = defineRpc({
  name: "repo-map.scan",
  input: z.object({ workspaceId: z.string() }),
  output: ScanSchema,
});

export const watch = defineSubscription({
  name: "repo-map.watch",
  input: z.object({ workspaceId: z.string() }),
  event: z.object({ type: z.literal("changed") }),
});
