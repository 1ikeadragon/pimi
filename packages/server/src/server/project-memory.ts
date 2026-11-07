import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { z } from "zod";
import { writePrivateFileAtomic } from "./private-files.js";

const MAX_PROJECT_NOTES = 64;

export const ProjectNoteKeySchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use a lowercase key such as build-command.");
export const ProjectNoteTextSchema = z.string().max(4000).regex(/\S/, "Enter a note.");

const ProjectNoteSchema = z.object({
  key: ProjectNoteKeySchema,
  text: ProjectNoteTextSchema,
  updatedAt: z.iso.datetime(),
});
const ProjectNotesSchema = z.array(ProjectNoteSchema).max(MAX_PROJECT_NOTES);
type ProjectNote = z.infer<typeof ProjectNoteSchema>;

export class ProjectMemory {
  // The daemon owns one store. Serialize read-modify-write operations even across tool sessions.
  private readonly mutate = pLimit(1);

  constructor(private readonly paseoHome: string) {}

  async list(projectId: string): Promise<Array<Omit<ProjectNote, "text">>> {
    const notes = await this.read(projectId);
    return notes.map(({ key, updatedAt }) => ({ key, updatedAt }));
  }

  async recall(projectId: string, key: string): Promise<ProjectNote | null> {
    const notes = await this.read(projectId);
    return notes.find((note) => note.key === key) ?? null;
  }

  async remember(projectId: string, key: string, text: string): Promise<void> {
    await this.mutate(async () => {
      const notes = await this.read(projectId);
      const index = notes.findIndex((note) => note.key === key);
      if (index < 0 && notes.length === MAX_PROJECT_NOTES) {
        throw new Error(
          `Project memory holds up to ${MAX_PROJECT_NOTES} notes. Forget a note or update an existing key.`,
        );
      }
      const note = ProjectNoteSchema.parse({ key, text, updatedAt: new Date().toISOString() });
      if (index < 0) notes.push(note);
      else notes[index] = note;
      await writePrivateFileAtomic(this.filePath(projectId), JSON.stringify(notes));
    });
  }

  async forget(projectId: string, key: string): Promise<boolean> {
    return this.mutate(async () => {
      const notes = await this.read(projectId);
      const remaining = notes.filter((note) => note.key !== key);
      if (remaining.length === notes.length) return false;
      await writePrivateFileAtomic(this.filePath(projectId), JSON.stringify(remaining));
      return true;
    });
  }

  private filePath(projectId: string): string {
    // Legacy project IDs can contain paths or remote URLs.
    const filename = createHash("sha256").update(projectId).digest("hex");
    return path.join(this.paseoHome, "projects", "memory", `${filename}.json`);
  }

  private async read(projectId: string): Promise<ProjectNote[]> {
    const raw = await readFile(this.filePath(projectId), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    return raw === null ? [] : ProjectNotesSchema.parse(JSON.parse(raw));
  }
}
