import { z } from "zod";

export const PIMI_ARTIFACT_FENCE = "pimi-artifact";

function isWorkspaceHtmlPath(path: string): boolean {
  return (
    /\.html?$/i.test(path) &&
    !/[\\:#?]/.test(path) &&
    !Array.from(path).some((character) => character.charCodeAt(0) < 32) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

const artifactSchema = z.object({
  title: z.string().trim().min(1),
  path: z
    .string()
    .trim()
    .transform((path) => path.replace(/^\.\//, ""))
    .refine(isWorkspaceHtmlPath),
});

export type ChatArtifact = z.infer<typeof artifactSchema>;

export function parseChatArtifact(source: string): ChatArtifact | null {
  try {
    return artifactSchema.safeParse(JSON.parse(source)).data ?? null;
  } catch {
    return null;
  }
}
