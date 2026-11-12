import { z } from "zod";

const TCP_PORT_RANGE_PATTERN = /^(\d{1,5})-(\d{1,5})$/;

export const PimiServicePortAllocationSchema = z
  .object({
    range: z.string().trim().regex(TCP_PORT_RANGE_PATTERN).optional(),
    portScript: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => value.range !== undefined || value.portScript !== undefined,
    "Expected range or portScript",
  )
  .refine((value) => {
    if (!value.range) return true;
    const match = TCP_PORT_RANGE_PATTERN.exec(value.range);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start >= 1 && end <= 65_535 && start <= end;
  }, "Expected an inclusive TCP port range from 1-65535");

export function normalizeLifecycleCommands(commands: unknown): string[] {
  if (typeof commands === "string") {
    return commands.trim().length > 0 ? [commands] : [];
  }
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.filter((command): command is string => {
    return typeof command === "string" && command.trim().length > 0;
  });
}

export const PimiLifecycleCommandRawSchema = z.union([z.string(), z.array(z.string())]);

export const PimiScriptEntryRawSchema = z
  .object({
    type: z.unknown().optional(),
    command: z.unknown().optional(),
    port: z.unknown().optional(),
  })
  .passthrough();

export const PimiWorktreeConfigRawSchema = z
  .object({
    setup: PimiLifecycleCommandRawSchema.optional(),
    teardown: PimiLifecycleCommandRawSchema.optional(),
    terminals: z.unknown().optional(),
    servicePorts: PimiServicePortAllocationSchema.optional(),
  })
  .passthrough();

export const PimiMetadataGenerationEntrySchema = z
  .object({
    instructions: z.string().optional(),
  })
  .passthrough()
  .catch({});

export const PimiMetadataGenerationSchema = z
  .object({
    title: PimiMetadataGenerationEntrySchema.optional(),
    branchName: PimiMetadataGenerationEntrySchema.optional(),
    commitMessage: PimiMetadataGenerationEntrySchema.optional(),
    pullRequest: PimiMetadataGenerationEntrySchema.optional(),
  })
  .passthrough()
  .catch({});

export const PimiConfigRawSchema = z
  .object({
    worktree: PimiWorktreeConfigRawSchema.optional(),
    scripts: z.record(z.string(), PimiScriptEntryRawSchema).optional(),
    metadataGeneration: PimiMetadataGenerationSchema.optional(),
  })
  .passthrough();

export const WorktreeConfigSchema = PimiWorktreeConfigRawSchema.extend({
  setup: z.unknown().optional().transform(normalizeLifecycleCommands),
  teardown: z.unknown().optional().transform(normalizeLifecycleCommands),
})
  .passthrough()
  .catch({ setup: [], teardown: [] });

export const ScriptEntrySchema = PimiScriptEntryRawSchema.catch({});

export const PimiConfigSchema = PimiConfigRawSchema.extend({
  worktree: WorktreeConfigSchema.optional(),
  scripts: z.record(z.string(), ScriptEntrySchema).optional().catch({}),
  metadataGeneration: PimiMetadataGenerationSchema.optional(),
})
  .passthrough()
  .catch({});

export const PimiConfigRevisionSchema = z.object({
  mtimeMs: z.number(),
  size: z.number(),
});

export const ProjectConfigRpcErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("project_not_found") }),
  z.object({ code: z.literal("invalid_project_config") }),
  z.object({
    code: z.literal("stale_project_config"),
    currentRevision: PimiConfigRevisionSchema.nullable(),
  }),
  z.object({ code: z.literal("write_failed") }),
]);

export type PimiScriptEntryRaw = z.infer<typeof PimiScriptEntryRawSchema>;
export type PimiMetadataGenerationEntry = z.infer<typeof PimiMetadataGenerationEntrySchema>;
export type PimiMetadataGeneration = z.infer<typeof PimiMetadataGenerationSchema>;
export type PimiServicePortAllocation = z.infer<typeof PimiServicePortAllocationSchema>;
export type PimiConfigRaw = z.infer<typeof PimiConfigRawSchema>;
export type PimiConfig = z.infer<typeof PimiConfigSchema>;
export type PimiConfigRevision = z.infer<typeof PimiConfigRevisionSchema>;
export type ProjectConfigRpcError = z.infer<typeof ProjectConfigRpcErrorSchema>;
