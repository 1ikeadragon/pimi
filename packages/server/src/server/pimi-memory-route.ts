import type { RequestHandler } from "express";
import { z } from "zod";
import {
  MemoryConflictError,
  ProjectNoteKeySchema,
  ProjectNoteTextSchema,
  type ProjectMemory,
} from "./project-memory.js";
import type { ProjectRegistry } from "./workspace-registry.js";

const project = { projectId: z.string().min(1).max(4096).nullable() };
const note = { ...project, key: ProjectNoteKeySchema };
const revision = z.iso.datetime();
const input = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("catalog") }),
  z.strictObject({ action: z.literal("list"), ...project }),
  z.strictObject({ action: z.literal("read"), ...note }),
  z.strictObject({
    action: z.literal("save"),
    ...note,
    text: ProjectNoteTextSchema,
    expectedUpdatedAt: revision.nullable(),
  }),
  z.strictObject({
    action: z.literal("forget"),
    ...note,
    expectedUpdatedAt: revision,
  }),
]);

export function createPimiMemoryHandler({
  memory,
  projects,
  reportError,
}: {
  memory: ProjectMemory;
  projects: Pick<ProjectRegistry, "get" | "list">;
  reportError: (error: unknown) => void;
}): RequestHandler {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const result = input.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: result.error.issues[0]?.message ?? "Invalid memory request." });
      return;
    }

    const request = result.data;
    try {
      if (request.action === "catalog") {
        const records = await projects.list();
        res.json({
          projects: records.map((record) => ({
            id: record.projectId,
            name: record.customName || record.displayName,
            root: record.rootPath,
            archived: Boolean(record.archivedAt),
          })),
        });
        return;
      }
      const { projectId } = request;
      if (projectId !== null && !(await projects.get(projectId))) {
        res.status(404).json({ error: "This project is no longer registered on this host." });
        return;
      }
      switch (request.action) {
        case "list":
          res.json({ notes: await memory.list(projectId) });
          return;
        case "read": {
          const saved = await memory.recall(projectId, request.key);
          if (!saved) {
            res.status(404).json({ error: "This note is no longer saved. Reload memory." });
            return;
          }
          res.json({ note: saved });
          return;
        }
        case "save":
          res.json({
            note: await memory.remember(
              projectId,
              request.key,
              request.text,
              request.expectedUpdatedAt,
            ),
          });
          return;
        case "forget":
          res.json({
            removed: await memory.forget(projectId, request.key, request.expectedUpdatedAt),
          });
      }
    } catch (error) {
      if (error instanceof MemoryConflictError) {
        res.status(409).json({ error: error.message });
        return;
      }
      reportError(error);
      res.status(500).json({ error: "Pimi couldn’t read or update memory on this host." });
    }
  };
}
