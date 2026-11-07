import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { z } from "zod";
import { writePrivateFileAtomic } from "./private-files.js";

const MAX_NOTES = 64;

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
const ProjectNotesSchema = z.array(ProjectNoteSchema).max(MAX_NOTES);
type ProjectNote = z.infer<typeof ProjectNoteSchema>;

export class MemoryConflictError extends Error {}

export class ProjectMemory {
  // The daemon owns one store. Serialize read-modify-write operations even across tool sessions.
  private readonly mutate = pLimit(1);

  constructor(private readonly paseoHome: string) {}

  async list(projectId: string | null): Promise<Array<Omit<ProjectNote, "text">>> {
    const notes = await this.read(projectId);
    return notes.map(({ key, updatedAt }) => ({ key, updatedAt }));
  }

  async recall(projectId: string | null, key: string): Promise<ProjectNote | null> {
    const notes = await this.read(projectId);
    return notes.find((note) => note.key === key) ?? null;
  }

  async remember(
    projectId: string | null,
    key: string,
    text: string,
    expectedUpdatedAt?: string | null,
  ): Promise<ProjectNote> {
    return this.mutate(async () => {
      const notes = await this.read(projectId);
      const index = notes.findIndex((note) => note.key === key);
      this.checkVersion(notes[index], expectedUpdatedAt);
      if (index < 0 && notes.length === MAX_NOTES) {
        throw new MemoryConflictError(
          `This memory scope holds up to ${MAX_NOTES} notes. Forget a note or update an existing key.`,
        );
      }
      const previous = index < 0 ? 0 : Date.parse(notes[index].updatedAt);
      const updatedAt = new Date(Math.max(Date.now(), previous + 1)).toISOString();
      const note = ProjectNoteSchema.parse({ key, text, updatedAt });
      if (index < 0) notes.push(note);
      else notes[index] = note;
      await writePrivateFileAtomic(this.filePath(projectId), JSON.stringify(notes));
      return note;
    });
  }

  async forget(
    projectId: string | null,
    key: string,
    expectedUpdatedAt?: string,
  ): Promise<boolean> {
    return this.mutate(async () => {
      const notes = await this.read(projectId);
      this.checkVersion(
        notes.find((note) => note.key === key),
        expectedUpdatedAt,
      );
      const remaining = notes.filter((note) => note.key !== key);
      if (remaining.length === notes.length) return false;
      await writePrivateFileAtomic(this.filePath(projectId), JSON.stringify(remaining));
      return true;
    });
  }

  private checkVersion(note: ProjectNote | undefined, expected: string | null | undefined): void {
    if (expected !== undefined && (note?.updatedAt ?? null) !== expected) {
      throw new MemoryConflictError(
        "This note changed. Reload memory before saving or forgetting it.",
      );
    }
  }

  private filePath(projectId: string | null): string {
    // Legacy project IDs can contain paths or remote URLs.
    const filename =
      projectId === null ? "global" : createHash("sha256").update(projectId).digest("hex");
    return path.join(this.paseoHome, "projects", "memory", `${filename}.json`);
  }

  private async read(projectId: string | null): Promise<ProjectNote[]> {
    const raw = await readFile(this.filePath(projectId), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    return raw === null ? [] : ProjectNotesSchema.parse(JSON.parse(raw));
  }
}
