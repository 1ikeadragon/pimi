import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  forkSession as claudeForkSession,
  type Query,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeRewindSdk {
  forkSession(
    sessionId: string,
    options: { upToMessageId: string; transcriptPath: string },
  ): Promise<{ sessionId: string }>;
}

// On its own, the SDK looks for the session under the daemon's CLAUDE_CONFIG_DIR, while a
// provider can point Claude Code at another one. Forking through a store rooted at the
// transcript's folder reads the session where Claude Code wrote it and writes the fork beside it.
export const realClaudeRewindSdk: ClaudeRewindSdk = {
  forkSession: (sessionId, options) =>
    claudeForkSession(sessionId, {
      upToMessageId: options.upToMessageId,
      sessionStore: projectFolderSessionStore(
        path.dirname(options.transcriptPath),
        options.upToMessageId,
      ),
    }),
};

/**
 * Most the entries the fork keeps in memory may take, as the bytes of their transcript lines.
 * The SDK parses them and then copies every one into the fork, so memory is a few times this
 * (the SDK's fork contract needs the whole entry list; see loadForkEntries). 256 MiB keeps the
 * peak near 1 GB inside the 3 GB worker heap; a chat past it gets ClaudeRewindTooLargeError
 * instead of an out-of-memory crash of the daemon that owns every other chat.
 */
export const REWIND_MAX_RETAINED_BYTES = 256 * 1024 * 1024;
/** Bytes of fork entries serialized and written per append, so no write holds the whole fork. */
export const REWIND_APPEND_CHUNK_BYTES = 8 * 1024 * 1024;
/** Longest the transcript read runs before yielding to timers and sockets. */
const REWIND_YIELD_MS = 8;
// The CLI writes each API request body as its own record; the SDK ignores them, and they are
// most of a large transcript, so they are skipped by prefix without parsing.
const API_REQUEST_PREFIX = '{"type":"api-request';
// Everything the SDK's fork reads from a transcript, by record type (sdk.mjs `F4`): conversation
// entries with a uuid, plus four bookkeeping records. Any other record is ignored by the SDK.
const FORK_CONVERSATION_TYPES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "attachment",
  "system",
  "progress",
]);
const FORK_BOOKKEEPING_TYPES: ReadonlySet<string> = new Set([
  "history-suppression",
  "atis-latch",
  "content-replacement",
  "relocated",
]);

export class ClaudeRewindTooLargeError extends Error {
  constructor(
    readonly retainedBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      `This conversation is too large to rewind: ${Math.round(retainedBytes / 1048576)} MB of ` +
        `messages up to that point, and the limit is ${Math.round(limitBytes / 1048576)} MB.`,
    );
    this.name = "ClaudeRewindTooLargeError";
  }
}

function projectFolderSessionStore(projectFolder: string, upToMessageId: string): SessionStore {
  const transcriptPath = (sessionId: string) => path.join(projectFolder, `${sessionId}.jsonl`);
  // The SDK stamps the fork's last entry with the fork time, which the chat then shows as the end
  // of that turn. Give the copy of the target the timestamp it had.
  let targetTimestamp: string | null = null;
  const keepTargetTimestamp = (entries: readonly SessionStoreEntry[]): SessionStoreEntry[] =>
    entries.map((entry) => {
      const from = entry.forkedFrom as { messageUuid?: unknown } | undefined;
      return targetTimestamp && from?.messageUuid === upToMessageId
        ? { ...entry, timestamp: targetTimestamp }
        : entry;
    });
  return {
    async load({ sessionId }) {
      const entries = await loadForkEntries(transcriptPath(sessionId), upToMessageId);
      const target = entries?.find((entry) => entry.uuid === upToMessageId);
      targetTimestamp = typeof target?.timestamp === "string" ? target.timestamp : null;
      return entries;
    },
    async append({ sessionId }, entries) {
      await appendEntriesInChunks(transcriptPath(sessionId), keepTargetTimestamp(entries));
    },
  };
}

function hasTitle(entry: Record<string, unknown>): boolean {
  return typeof entry.customTitle === "string" || typeof entry.aiTitle === "string";
}

/**
 * The entries the SDK's fork of `upToMessageId` reads, streamed from the transcript instead of
 * read whole. The SDK slices the conversation at the target and ignores every record it does not
 * list, so the same fork results from dropping api-request records, other record types,
 * sidechain entries, and conversation entries after the target. Bookkeeping records and titles
 * are kept wherever they sit, because the SDK reads those from the whole file. The SDK's own
 * contract (`SessionStore.load`) returns the entry list, so what remains is held in memory:
 * hence REWIND_MAX_RETAINED_BYTES.
 */
async function loadForkEntries(
  file: string,
  upToMessageId: string,
): Promise<SessionStoreEntry[] | null> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const entries: SessionStoreEntry[] = [];
  let retainedBytes = 0;
  let reachedTarget = false;
  let lastYield = performance.now();
  try {
    for await (const line of lines) {
      if (line.startsWith(API_REQUEST_PREFIX) || !line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Skip a line that is not JSON, as the SDK's own transcript reader does.
        continue;
      }
      if (!isSessionStoreEntry(parsed)) continue;
      const record: Record<string, unknown> = parsed;
      if (FORK_CONVERSATION_TYPES.has(parsed.type) && typeof record.uuid === "string") {
        if (record.isSidechain === true || reachedTarget) continue;
        if (record.uuid === upToMessageId) reachedTarget = true;
      } else if (!FORK_BOOKKEEPING_TYPES.has(parsed.type) && !hasTitle(record)) {
        continue;
      }
      retainedBytes += line.length;
      if (retainedBytes > REWIND_MAX_RETAINED_BYTES) {
        throw new ClaudeRewindTooLargeError(retainedBytes, REWIND_MAX_RETAINED_BYTES);
      }
      entries.push(parsed);
      if (performance.now() - lastYield >= REWIND_YIELD_MS) {
        await setImmediate();
        lastYield = performance.now();
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  return entries;
}

async function appendEntriesInChunks(
  file: string,
  entries: readonly SessionStoreEntry[],
): Promise<void> {
  const handle = await open(file, "a");
  try {
    let pending: string[] = [];
    let pendingBytes = 0;
    for (const entry of entries) {
      const line = `${JSON.stringify(entry)}\n`;
      pending.push(line);
      pendingBytes += line.length;
      if (pendingBytes >= REWIND_APPEND_CHUNK_BYTES) {
        await handle.appendFile(pending.join(""), "utf8");
        pending = [];
        pendingBytes = 0;
        await setImmediate();
      }
    }
    if (pending.length > 0) await handle.appendFile(pending.join(""), "utf8");
  } finally {
    await handle.close();
  }
}

function isSessionStoreEntry(value: unknown): value is SessionStoreEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * The entry a message steered into a running turn follows. Claude Code gives such a message no
 * entry of its own: it records a queued_command attachment, under the uuid Pimi minted for the
 * message, hung off the entry it was read after. Forking at that entry drops the message and
 * everything after it. Null when the transcript holds no such attachment.
 */
export async function findSteeredMessageParent(
  transcriptPath: string,
  messageId: string,
): Promise<string | null> {
  const input = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.includes(messageId) || !line.includes('"queued_command"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const record = entry as {
        type?: unknown;
        parentUuid?: unknown;
        attachment?: { type?: unknown; source_uuid?: unknown };
      };
      if (
        record.type === "attachment" &&
        record.attachment?.type === "queued_command" &&
        record.attachment.source_uuid === messageId &&
        typeof record.parentUuid === "string"
      ) {
        return record.parentUuid;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  return null;
}

/**
 * Where a conversation rewind to `userMessageId` must fork, read from the transcript when the
 * session did not track that turn (it was never replayed into memory). `forkAt` is the last
 * assistant entry before the target, null when the target opens the conversation, and `found` is
 * false when the transcript holds no such user entry. Streams the file line by line.
 */
export async function findRewindForkPoint(
  transcriptPath: string,
  userMessageId: string,
): Promise<{ found: boolean; forkAt: string | null }> {
  const input = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lastAssistantId: string | null = null;
  try {
    for await (const line of lines) {
      if (line.startsWith(API_REQUEST_PREFIX)) continue;
      const isTarget = line.includes(userMessageId);
      if (!isTarget && !line.includes('"type":"assistant"')) continue;
      let record: { type?: unknown; uuid?: unknown; isSidechain?: unknown };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        // A truncated or foreign line cannot be a conversation entry; the SDK skips it too.
        continue;
      }
      if (record.isSidechain === true) continue;
      if (record.uuid === userMessageId && record.type === "user") {
        return { found: true, forkAt: lastAssistantId };
      }
      if (record.type === "assistant" && typeof record.uuid === "string") {
        lastAssistantId = record.uuid;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { found: false, forkAt: null };
}

export async function revertClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  transcriptPath: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void | Promise<void>;
}): Promise<void> {
  if (!input.sessionId || !input.transcriptPath) {
    throw new Error("Claude session is not ready for rewind");
  }
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: messageId,
    transcriptPath: input.transcriptPath,
  });
  await input.setSessionId(fork.sessionId);
}

export async function revertClaudeFiles(input: {
  query: Query;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
}): Promise<void> {
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const result = await input.query.rewindFiles(messageId, { dryRun: false });
  if (!result.canRewind) {
    throw new Error(result.error ?? `No file checkpoint found for message ${messageId}`);
  }
}

export async function revertClaudeConversationAndFiles(input: {
  sdk: ClaudeRewindSdk;
  query: Query;
  sessionId: string | null;
  transcriptPath: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void | Promise<void>;
}): Promise<void> {
  await revertClaudeFiles({
    query: input.query,
    messageId: input.messageId,
    resolveMessageId: input.resolveMessageId,
  });
  await revertClaudeConversation(input);
}
