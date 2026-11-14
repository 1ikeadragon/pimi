// Pimi. PolyForm-Noncommercial-1.0.0.
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import {
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  TaskImportRecordSchema,
  type TaskImportRecord,
  type TaskStatus,
} from "@pimi/protocol/task/types";

// COMPAT(pimi-tasks.json): the pre-daemon desktop task file, imported once into the daemon.
const LEGACY_TASK_FILE = "pimi-tasks.json";

const STAGE_STATUS: Record<string, TaskStatus> = {
  backlog: "todo",
  ready: "todo",
  "in-progress": "in_progress",
  review: "in_progress",
  done: "done",
};

export interface TaskImportTarget {
  importTasks(tasks: TaskImportRecord[]): Promise<{ imported: number; skipped: number }>;
  localServerId(): Promise<string>;
}

let importing: Promise<void> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyStatus(task: Record<string, unknown>): TaskStatus {
  // A stage owns the status; without one, the old `done` flag decides.
  if (typeof task.stage === "string" && task.stage in STAGE_STATUS) {
    return STAGE_STATUS[task.stage];
  }
  return task.done === true ? "done" : "todo";
}

function mapLegacyTask(task: unknown, localServerId: string): TaskImportRecord | null {
  if (!isRecord(task) || typeof task.id !== "string" || typeof task.title !== "string") {
    return null;
  }
  const status = legacyStatus(task);
  const source = isRecord(task.source) ? task.source : undefined;
  // Only a chat on this daemon can be linked; a task made on another host keeps no creator.
  const creatorAgentId =
    source?.serverId === localServerId && typeof source.agentId === "string"
      ? source.agentId
      : undefined;
  const labels = Array.isArray(task.labels)
    ? [...new Set(task.labels.filter((name): name is string => typeof name === "string"))]
    : [];
  const parsed = TaskImportRecordSchema.safeParse({
    id: task.id,
    title: task.title.trim().slice(0, TASK_TITLE_MAX_LENGTH),
    description: (typeof task.brief === "string" ? task.brief : "").slice(
      0,
      TASK_DESCRIPTION_MAX_LENGTH,
    ),
    status,
    labelNames: labels,
    ...(creatorAgentId ? { creatorAgentId } : {}),
    ...(status === "done" && typeof task.completedAt === "string"
      ? { completedAt: task.completedAt }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}

async function runImport(target: TaskImportTarget): Promise<void> {
  const file = path.join(app.getPath("userData"), LEGACY_TASK_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const stored: unknown = JSON.parse(raw);
  if (!Array.isArray(stored)) throw new Error(`${LEGACY_TASK_FILE} is not a task list.`);
  const localServerId = await target.localServerId();
  const records = stored.flatMap((task) => mapLegacyTask(task, localServerId) ?? []);
  if (records.length < stored.length) {
    log.warn(
      `[pimi] ${stored.length - records.length} legacy task(s) could not be mapped and were not imported`,
    );
  }
  const result = records.length ? await target.importTasks(records) : { imported: 0, skipped: 0 };
  // The file stays on disk as .migrated; the daemon skips ids it already has.
  await rename(file, `${file}.migrated`);
  log.info(
    `[pimi] imported ${result.imported} legacy task(s), ${result.skipped} skipped, from ${LEGACY_TASK_FILE}`,
  );
}

/** Imports `<userData>/pimi-tasks.json` into the daemon once, then renames it `.migrated`. */
export function importLegacyPimiTasks(target: TaskImportTarget): Promise<void> {
  importing ??= runImport(target)
    .catch((error) => {
      // The file is untouched, so the next daemon start retries.
      log.error("[pimi] legacy task import failed", error);
    })
    .finally(() => {
      importing = undefined;
    });
  return importing;
}
