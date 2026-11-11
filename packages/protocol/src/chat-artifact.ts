import { z } from "zod";

export const PIMI_ARTIFACT_FENCE = "pimi-artifact";

const artifactSchema = z.object({
  title: z.string().trim().min(1),
  path: z
    .string()
    .trim()
    .transform((path) => path.replace(/^\.\//, ""))
    .refine((path) => /\.html?$/i.test(path)),
});

export type ChatArtifact = z.infer<typeof artifactSchema>;

export function parseChatArtifact(source: string): ChatArtifact | null {
  try {
    return artifactSchema.safeParse(JSON.parse(source)).data ?? null;
  } catch {
    return null;
  }
}
