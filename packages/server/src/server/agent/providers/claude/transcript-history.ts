import { assignTaskNotificationReplayIds } from "./task-notification-tool-call.js";
import fs, { type FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import path from "node:path";
import { normalizeProviderReplayTimestamp } from "../../provider-history-timestamps.js";
import {
  parseClaudeSubagentMeta,
  type ClaudeReplayEntry,
  type ClaudeSubagentMeta,
} from "./subagents/replay-source.js";
import {
  parseClaudeWorkflowRun,
  type ClaudeWorkflowRun,
} from "./subagents/workflow-replay-source.js";

interface TranscriptEntry extends ClaudeReplayEntry {
  isSidechain?: unknown;
}

interface RecordLocation {
  file: string;
  offset: number;
  length: number;
  timestamp: string | null;
}

/** Chunk in bytes so UTF-8 and multi-chunk records are decoded once, at a line boundary. */
async function* locatedRecords(
  file: string,
  fd: FileHandle,
): AsyncGenerator<{ entry: TranscriptEntry; location: RecordLocation }> {
  const stat = await fd.stat();
  // Opening a directory succeeds on some platforms; it must never look like empty history.
  if (stat.isDirectory()) {
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${file}'`), {
      code: "EISDIR",
      syscall: "read",
      path: file,
    });
  }
  let remaining = stat.size;
  let offset = 0;
  let pieces: Buffer[] = [];
  let length = 0;
  while (remaining > 0) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead: count } = await fd.read(buffer, 0, buffer.length, null);
    if (count === 0) break;
    remaining -= count;
    let start = 0;
    let end: number;
    while ((end = buffer.indexOf(10, start)) !== -1 && end < count) {
      pieces.push(buffer.subarray(start, end));
      length += end - start;
      const entry = parseRecord(Buffer.concat(pieces, length).toString("utf8"));
      const location = {
        file,
        offset,
        length,
        timestamp: normalizeProviderReplayTimestamp(entry?.timestamp),
      };
      offset += length + 1;
      pieces = [];
      length = 0;
      if (entry) yield { entry, location };
      start = end + 1;
    }
    // Bound parsing work as well as IO; microtasks alone do not service timers or sockets.
    await setImmediate();
    if (start < count) {
      pieces.push(buffer.subarray(start, count));
      length += count - start;
    }
  }
  const entry = parseRecord(Buffer.concat(pieces, length).toString("utf8"));
  if (entry)
    yield {
      entry,
      location: {
        file,
        offset,
        length,
        timestamp: normalizeProviderReplayTimestamp(entry.timestamp),
      },
    };
}

/** Indexed sources parse only their own records using descriptors owned by this replay. */
function indexedRecords(
  locations: readonly RecordLocation[],
  descriptors: ReadonlyMap<string, FileHandle>,
): AsyncIterable<TranscriptEntry> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* assignTaskNotificationReplayIds(readEntries());
    },
  };
  async function* readEntries(): AsyncGenerator<TranscriptEntry> {
    for (const location of locations) {
      const fd = descriptors.get(location.file)!;
      const buffer = Buffer.allocUnsafe(location.length);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead: count } = await fd.read(
          buffer,
          read,
          buffer.length - read,
          location.offset + read,
        );
        if (count === 0)
          throw new Error(`Claude transcript was truncated during replay: ${location.file}`);
        read += count;
      }
      const entry = parseRecord(buffer.toString("utf8"));
      if (entry) yield entry;
    }
  }
}

function isToolResult(entry: TranscriptEntry): boolean {
  return (
    Array.isArray(entry.message?.content) &&
    entry.message.content.some((block) => block?.type === "tool_result")
  );
}

function parseRecord(line: string): TranscriptEntry | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as TranscriptEntry)
      : null;
  } catch {
    return null;
  }
}

async function readOptionalFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

const WINDOW_READ_BYTES = 1024 * 1024;
/** A window that cannot find its turn boundary inside this much transcript falls back to a full replay. */
const WINDOW_MAX_SCAN_BYTES = 64 * 1024 * 1024;
/** Transcripts smaller than this replay in full; the window only pays for itself on big files. */
export const CLAUDE_WINDOWED_REPLAY_MIN_BYTES = 1024 * 1024;
// The Claude CLI writes every API request body as its own record. They are never replay input and
// are the bulk of a large transcript, so they are skipped by prefix without parsing.
const NOISE_RECORD_PREFIX = Buffer.from('{"type":"api-request');

export interface ClaudeTranscriptWindow {
  /** Parent-conversation records in chronological order, starting at a user prompt. */
  entries: AsyncIterable<TranscriptEntry>;
  /** Byte offset of the first record of this window; 0 means no older records exist. */
  startOffset: number;
}

/** True when the session owns sidechain or workflow files. Their ownership is resolved across the
 * whole parent transcript, so such sessions cannot be replayed one window at a time. */
export async function claudeTranscriptHasSidechains(historyPath: string): Promise<boolean> {
  const sessionDirectory = path.join(
    path.dirname(historyPath),
    path.basename(historyPath, ".jsonl"),
  );
  const subagents = await optionalDirectory(path.join(sessionDirectory, "subagents"));
  if (subagents.length > 0) return true;
  return (await optionalDirectory(path.join(sessionDirectory, "workflows"))).length > 0;
}

/** Lines of the file before `end`, last line first, with each line's byte offset. */
async function* reverseLines(
  fd: FileHandle,
  end: number,
  scanLimit: number,
): AsyncGenerator<{ line: Buffer; offset: number }> {
  let position = end;
  let carry: Buffer = Buffer.alloc(0);
  let scanned = 0;
  while (position > 0) {
    const length = Math.min(WINDOW_READ_BYTES, position);
    position -= length;
    scanned += length;
    if (scanned > scanLimit) throw new WindowTooLargeError();
    const block = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await fd.read(block, read, length - read, position + read);
      if (bytesRead === 0) throw new WindowTooLargeError();
      read += bytesRead;
    }
    const data = carry.length > 0 ? Buffer.concat([block, carry]) : block;
    let cursor = data.length;
    if (data[cursor - 1] === 10) cursor -= 1;
    let newline = cursor > 0 ? data.lastIndexOf(10, cursor - 1) : -1;
    while (newline !== -1) {
      yield { line: data.subarray(newline + 1, cursor), offset: position + newline + 1 };
      cursor = newline;
      newline = cursor > 0 ? data.lastIndexOf(10, cursor - 1) : -1;
    }
    // The first line of this block may continue into the previous one.
    carry = Buffer.from(data.subarray(0, cursor));
  }
  if (carry.length > 0) yield { line: carry, offset: 0 };
}

class WindowTooLargeError extends Error {}

function isNoiseRecord(line: Buffer): boolean {
  return line.subarray(0, NOISE_RECORD_PREFIX.length).equals(NOISE_RECORD_PREFIX);
}

/**
 * Read the newest `prompts` user turns that end before `endOffset` (default end of file) by
 * scanning the file backwards, so the cost follows the window and not the transcript size.
 * Returns null when the window would need more than WINDOW_MAX_SCAN_BYTES.
 */
export async function readClaudeTranscriptWindow(
  historyPath: string,
  options: { prompts: number; endOffset?: number },
): Promise<ClaudeTranscriptWindow | null> {
  const fd = await fs.open(historyPath, "r");
  try {
    const stat = await fd.stat();
    if (stat.isDirectory()) return null;
    const end = Math.min(options.endOffset ?? stat.size, stat.size);
    const found: TranscriptEntry[] = [];
    let prompts = 0;
    let startOffset = 0;
    for await (const { line, offset } of reverseLines(fd, end, WINDOW_MAX_SCAN_BYTES)) {
      if (line.length === 0 || isNoiseRecord(line)) continue;
      const entry = parseRecord(line.toString("utf8"));
      if (!entry || entry.isSidechain === true) continue;
      found.push(entry);
      if (entry.type !== "user" || isToolResult(entry)) continue;
      prompts += 1;
      if (prompts >= options.prompts) {
        startOffset = offset;
        break;
      }
    }
    found.reverse();
    return {
      entries: assignTaskNotificationReplayIds(
        (async function* () {
          yield* found;
        })(),
      ),
      startOffset,
    };
  } catch (error) {
    if (error instanceof WindowTooLargeError) return null;
    throw error;
  } finally {
    await fd.close();
  }
}

/** Discover sources without retaining transcript contents. Unrelated sidechains stay excluded
 * by the replay ownership resolver; workflow children retain their separate run ownership. */
export interface ClaudeReplayHistory {
  parentEntries: AsyncIterable<TranscriptEntry>;
  subagents: {
    agentId: string;
    meta: ClaudeSubagentMeta | null;
    entries: AsyncIterable<TranscriptEntry>;
  }[];
  workflows: ClaudeWorkflowRun[];
  workflowEntriesByRunId: Map<string, AsyncIterable<TranscriptEntry>>;
}

/** Own descriptors through every pass so unlink or rename cannot invalidate discovered history.
 * Sources must be consumed before the callback returns. No transcript copies are needed. */
export async function withClaudeReplayHistory<T>(
  historyPath: string,
  consume: (history: ClaudeReplayHistory) => Promise<T>,
): Promise<T> {
  const descriptors = new Map<string, FileHandle>();
  try {
    return await consume(await indexHistory(historyPath, descriptors));
  } finally {
    await closeReplaySources(descriptors.values());
  }
}

async function closeReplaySources(descriptors: Iterable<FileHandle>): Promise<void> {
  const results = await Promise.allSettled([...descriptors].map((fd) => fd.close()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

async function indexHistory(
  historyPath: string,
  descriptors: Map<string, FileHandle>,
): Promise<ClaudeReplayHistory> {
  const sessionDirectory = path.join(
    path.dirname(historyPath),
    path.basename(historyPath, ".jsonl"),
  );
  const sidechainDirectory = path.join(sessionDirectory, "subagents");
  const sidechainFiles = [historyPath];
  const workflowFiles = new Map<string, string[]>();
  const metaByAgentId = new Map<string, ClaudeSubagentMeta>();
  const directories = [sidechainDirectory];
  while (directories.length) {
    const directory = directories.pop()!;
    for (const entry of await optionalDirectory(directory)) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".jsonl")) {
        const parts = path.relative(sidechainDirectory, file).split(path.sep);
        if (parts[0] === "workflows" && parts.length >= 3) {
          const runId = parts[1]!;
          const files = workflowFiles.get(runId) ?? [];
          files.push(file);
          workflowFiles.set(runId, files);
        } else sidechainFiles.push(file);
        continue;
      }
      const agentId = /^agent-(.+)\.meta\.json$/.exec(entry.name)?.[1];
      if (!agentId) continue;
      const contents = await readOptionalFile(file);
      const meta = contents === null ? null : parseClaudeSubagentMeta(contents);
      if (meta) metaByAgentId.set(agentId, meta);
    }
  }
  const parentLocations: RecordLocation[] = [];
  const locationsByAgentId = new Map<string, RecordLocation[]>();
  async function scan(
    file: string,
    visit: (entry: TranscriptEntry, location: RecordLocation) => void,
  ): Promise<void> {
    const fd = await fs.open(file, "r");
    descriptors.set(file, fd);
    for await (const { entry, location } of locatedRecords(file, fd)) visit(entry, location);
  }
  for (const file of sidechainFiles) {
    await scan(file, (entry, location) => {
      if (file === historyPath && entry.isSidechain !== true) parentLocations.push(location);
      if (entry.isSidechain !== true || typeof entry.agentId !== "string") return;
      const locations = locationsByAgentId.get(entry.agentId) ?? [];
      locations.push(location);
      locationsByAgentId.set(entry.agentId, locations);
    });
  }
  const workflowEntriesByRunId = new Map<string, AsyncIterable<TranscriptEntry>>();
  for (const [runId, files] of workflowFiles) {
    const locations: RecordLocation[] = [];
    for (const file of files)
      await scan(file, (entry, location) => {
        if (entry.type !== "user" || isToolResult(entry)) locations.push(location);
      });
    locations.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return Date.parse(a.timestamp) - Date.parse(b.timestamp);
    });
    workflowEntriesByRunId.set(runId, indexedRecords(locations, descriptors));
  }
  return {
    parentEntries: indexedRecords(parentLocations, descriptors),
    subagents: [...locationsByAgentId].map(([agentId, locations]) => ({
      agentId,
      meta: metaByAgentId.get(agentId) ?? null,
      entries: indexedRecords(locations, descriptors),
    })),
    workflows: await readWorkflows(sessionDirectory),
    workflowEntriesByRunId,
  };
}

async function readWorkflows(sessionDirectory: string): Promise<ClaudeWorkflowRun[]> {
  const workflows: ClaudeWorkflowRun[] = [];
  const workflowDirectory = path.join(sessionDirectory, "workflows");
  for (const entry of await optionalDirectory(workflowDirectory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const contents = await readOptionalFile(path.join(workflowDirectory, entry.name));
    const workflow = contents === null ? null : parseClaudeWorkflowRun(contents);
    if (workflow) workflows.push(workflow);
  }
  return workflows;
}

async function optionalDirectory(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
