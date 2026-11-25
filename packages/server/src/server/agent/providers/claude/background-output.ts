import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BACKGROUND_OUTPUT_PAGE_LIMIT,
  type BackgroundWorkOutputPage,
} from "../../background-work/output.js";

export class BackgroundWorkOutputUnavailableError extends Error {
  constructor(message = "Background work output is no longer available") {
    super(message);
    this.name = "BackgroundWorkOutputUnavailableError";
  }
}

export interface BackgroundShellLaunch {
  taskId: string;
  toolUseId: string;
  outputFile: string;
}

const ResultContentSchema = z.union([
  z.string(),
  z.array(z.object({ text: z.string().optional() }).passthrough()),
]);

const LaunchResultSchema = z.object({
  type: z.literal("user"),
  session_id: z.string(),
  tool_use_result: z.object({ backgroundTaskId: z.string().min(1) }).passthrough(),
  message: z.object({
    content: z.array(
      z
        .object({
          type: z.string(),
          tool_use_id: z.string().optional(),
          content: ResultContentSchema.optional(),
        })
        .passthrough(),
    ),
  }),
});

const TRAILING_PUNCTUATION = /[.,;:'")\]]+$/;

/**
 * Reads where a background shell writes its output from the launch result. The task id is
 * structured; the path is the absolute token in the result text named `<task id>.output` that
 * sits in this session's tasks directory. Anything else yields no launch and so no preview.
 */
export function readBackgroundShellLaunch(message: unknown): BackgroundShellLaunch | null {
  const parsed = LaunchResultSchema.safeParse(message);
  if (!parsed.success) return null;
  const { session_id: sessionId, tool_use_result: result } = parsed.data;
  const taskId = result.backgroundTaskId;
  for (const block of parsed.data.message.content) {
    if (block.type !== "tool_result" || !block.tool_use_id) continue;
    const outputFile = findOutputFile(resultText(block.content), taskId);
    if (outputFile && isSessionTaskOutput(outputFile, sessionId, taskId)) {
      return { taskId, toolUseId: block.tool_use_id, outputFile };
    }
  }
  return null;
}

/** The path a task notification reports, when it is this session's output file for the task. */
export function readNotifiedOutputFile(
  outputFile: string | undefined,
  sessionId: string,
  taskId: string,
): string | null {
  return outputFile && isSessionTaskOutput(outputFile, sessionId, taskId) ? outputFile : null;
}

function resultText(content: z.infer<typeof ResultContentSchema> | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("\n");
}

function findOutputFile(text: string, taskId: string): string | null {
  for (const token of text.split(/\s+/)) {
    const candidate = token.replace(TRAILING_PUNCTUATION, "");
    if (path.isAbsolute(candidate) && path.basename(candidate) === `${taskId}.output`) {
      return candidate;
    }
  }
  return null;
}

function isSessionTaskOutput(file: string, sessionId: string, taskId: string): boolean {
  const tasksDir = path.dirname(file);
  return (
    path.basename(file) === `${taskId}.output` &&
    path.basename(tasksDir) === "tasks" &&
    path.basename(path.dirname(tasksDir)) === sessionId
  );
}

/**
 * Reads one page of a task output file: the newest page on the first read or when the reader
 * fell behind, otherwise what was appended since `cursor`. The cursor counts bytes. The file must
 * resolve to a regular file inside its own tasks directory; a symlink out of it is refused.
 */
export async function readTaskOutputPage(
  file: string,
  cursor: number | null,
): Promise<BackgroundWorkOutputPage> {
  const handle = await openTaskOutput(file);
  try {
    const { size } = await handle.stat();
    const resumes =
      cursor !== null && cursor <= size && size - cursor <= BACKGROUND_OUTPUT_PAGE_LIMIT;
    const start = resumes ? cursor : Math.max(0, size - BACKGROUND_OUTPUT_PAGE_LIMIT);
    const buffer = Buffer.alloc(Math.min(size - start, BACKGROUND_OUTPUT_PAGE_LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead);
    const head = !resumes && start > 0 ? continuationBytes(bytes) : 0;
    const end = Math.max(head, completeUtf8Length(bytes));
    return {
      output: bytes.subarray(head, end).toString("utf8"),
      cursor: start + end,
      skipped: !resumes && (start > 0 || cursor !== null),
    };
  } finally {
    await handle.close();
  }
}

async function openTaskOutput(file: string) {
  try {
    const tasksDir = await realpath(path.dirname(file));
    const resolved = await realpath(file);
    if (resolved !== path.join(tasksDir, path.basename(file))) {
      throw new BackgroundWorkOutputUnavailableError("Background work output path is not allowed");
    }
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      throw new BackgroundWorkOutputUnavailableError("Background work output path is not allowed");
    }
    return handle;
  } catch (error) {
    if (error instanceof BackgroundWorkOutputUnavailableError) throw error;
    if (isErrno(error, "ENOENT")) throw new BackgroundWorkOutputUnavailableError();
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Leading bytes that continue a character begun before the page; they cannot be decoded. */
function continuationBytes(bytes: Buffer): number {
  let count = 0;
  while (count < bytes.length && count < 3 && (bytes[count] & 0xc0) === 0x80) count++;
  return count;
}

/** Length of the prefix that does not end inside a multi-byte character. */
function completeUtf8Length(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    return utf8Width(byte) > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

function utf8Width(leadByte: number): number {
  if (leadByte >= 0xf0) return 4;
  if (leadByte >= 0xe0) return 3;
  if (leadByte >= 0xc0) return 2;
  return 1;
}
