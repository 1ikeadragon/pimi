import { z } from "zod";

export const ProviderHarnessUpdateChannelSchema = z.enum([
  "claude-stable",
  "codex-cli",
  "codex-app",
  "copilot",
  "omp",
  "opencode-v1",
  "opencode-v2",
  "pi",
]);

export const ProviderHarnessUpdateSchema = z.object({
  provider: z.string(),
  label: z.string(),
  channel: ProviderHarnessUpdateChannelSchema,
  installedVersion: z.string(),
  latestVersion: z.string().nullable(),
  status: z.enum(["current", "update_available", "unavailable", "managed"]),
});

export type ProviderHarnessUpdate = z.infer<typeof ProviderHarnessUpdateSchema>;
export type ProviderHarnessUpdateChannel = z.infer<typeof ProviderHarnessUpdateChannelSchema>;
