import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  AgentAttachmentSchema,
  AgentImageRefSchema,
  type AgentAttachment,
} from "@pimi/protocol/messages";
import type { AgentImageRef } from "@pimi/protocol/agent-types";
import { LruMap } from "./lru-map.js";
import { agentImageId, isSupportedImageMimeType } from "./agent-images.js";

/**
 * Timeline rows are rebuilt from provider history, which keeps only a message's text. What a
 * sent message carried (attachment pills, screenshots) lives here so a reload, a reconnect and a
 * second client show the same pills. Records are matched back to replayed messages by id.
 */

export const MAX_SENT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SENT_IMAGE_BYTES_PER_MESSAGE = 15 * 1024 * 1024;
export const MAX_SENT_ATTACHMENT_TEXT_CHARS = 32 * 1024;
export const MAX_SENT_ATTACHMENTS_PER_MESSAGE = 32;

const MAX_CACHED_AGENTS = 64;
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface SentAttachmentRecord {
  clientMessageId: string;
  providerMessageId?: string;
  /** What the user typed, without attachment bodies. */
  text: string;
  attachments: AgentAttachment[];
  /** Positional: an entry stays in place, marked unavailable, when its bytes were not kept. */
  images: AgentImageRef[];
}

export interface SentImageInput {
  mimeType: string;
  /** Base64. */
  data: string;
}

const RECORD_SCHEMA = z.object({
  clientMessageId: z.string(),
  providerMessageId: z.string().optional(),
  text: z.string(),
  attachments: z.array(AgentAttachmentSchema),
  images: z.array(AgentImageRefSchema),
});
const FILE_SCHEMA = z.object({ version: z.literal(1), records: z.array(RECORD_SCHEMA) });

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function clampAttachment(attachment: AgentAttachment): AgentAttachment {
  if (attachment.type === "text" && attachment.text.length > MAX_SENT_ATTACHMENT_TEXT_CHARS) {
    return { ...attachment, text: attachment.text.slice(0, MAX_SENT_ATTACHMENT_TEXT_CHARS) };
  }
  if (
    (attachment.type === "forge_change_request" || attachment.type === "forge_issue") &&
    attachment.body &&
    attachment.body.length > MAX_SENT_ATTACHMENT_TEXT_CHARS
  ) {
    return { ...attachment, body: attachment.body.slice(0, MAX_SENT_ATTACHMENT_TEXT_CHARS) };
  }
  return attachment;
}

/**
 * Decides what of a sent message is worth keeping. Image refs line up with the sent images; one
 * whose bytes are not kept stays in place, marked unavailable, so screenshot indexes hold.
 */
export function prepareSentAttachments(input: {
  attachments: readonly AgentAttachment[];
  images: readonly SentImageInput[];
}): {
  attachments: AgentAttachment[];
  images: AgentImageRef[];
  /** Bytes to store, keyed by image id. */
  blobs: Map<string, { bytes: Buffer; mimeType: string }>;
} {
  const images: AgentImageRef[] = [];
  const blobs = new Map<string, { bytes: Buffer; mimeType: string }>();
  let total = 0;
  for (const image of input.images) {
    const bytes = Buffer.from(image.data, "base64");
    const ref: AgentImageRef = {
      imageId: agentImageId(bytes),
      mimeType: image.mimeType,
      byteSize: bytes.length,
    };
    if (!isSupportedImageMimeType(image.mimeType)) {
      images.push({ ...ref, unavailable: "unsupported" });
    } else if (
      bytes.length > MAX_SENT_IMAGE_BYTES ||
      total + bytes.length > MAX_SENT_IMAGE_BYTES_PER_MESSAGE
    ) {
      images.push({ ...ref, unavailable: "too_large" });
    } else {
      total += bytes.length;
      blobs.set(ref.imageId, { bytes, mimeType: image.mimeType });
      images.push(ref);
    }
  }
  const attachments: AgentAttachment[] = [];
  for (const raw of input.attachments) {
    // The history a handoff carries is the chat's own and is never a pill.
    if (raw.type === "text" && raw.contextKind === "chat_history") continue;
    if (attachments.length >= MAX_SENT_ATTACHMENTS_PER_MESSAGE) break;
    attachments.push(clampAttachment(raw));
  }
  return { attachments, images, blobs };
}

export interface SentAttachmentStore {
  load(agentId: string): Promise<readonly SentAttachmentRecord[]>;
  append(agentId: string, record: SentAttachmentRecord): Promise<void>;
  setProviderMessageId(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): Promise<void>;
  delete(agentId: string): Promise<void>;
}

export class FileSentAttachmentStore implements SentAttachmentStore {
  private readonly logger: Logger;
  // Bounded: records reload from disk for an agent that fell out.
  private readonly cache = new LruMap<string, SentAttachmentRecord[]>(MAX_CACHED_AGENTS);
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly directory: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "agent", component: "sent-attachments" });
  }

  async load(agentId: string): Promise<readonly SentAttachmentRecord[]> {
    return this.enqueue(agentId, () => this.records(agentId));
  }

  async append(agentId: string, record: SentAttachmentRecord): Promise<void> {
    await this.enqueue(agentId, async () => {
      const records = await this.records(agentId);
      if (records.some((existing) => existing.clientMessageId === record.clientMessageId)) return;
      records.push(record);
      await this.persist(agentId, records);
    });
  }

  async setProviderMessageId(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): Promise<void> {
    await this.enqueue(agentId, async () => {
      const records = await this.records(agentId);
      const record = records.find((candidate) => candidate.clientMessageId === clientMessageId);
      if (!record || record.providerMessageId === providerMessageId) return;
      record.providerMessageId = providerMessageId;
      await this.persist(agentId, records);
    });
  }

  async delete(agentId: string): Promise<void> {
    await this.enqueue(agentId, async () => {
      this.cache.delete(agentId);
      await fs.rm(this.filePath(agentId), { force: true });
    });
  }

  private enqueue<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    this.queues.set(agentId, tail);
    void tail.finally(() => {
      if (this.queues.get(agentId) === tail) this.queues.delete(agentId);
    });
    return run;
  }

  private async records(agentId: string): Promise<SentAttachmentRecord[]> {
    const cached = this.cache.get(agentId);
    if (cached) return cached;
    let records: SentAttachmentRecord[] = [];
    try {
      const parsed = FILE_SCHEMA.safeParse(
        JSON.parse(await fs.readFile(this.filePath(agentId), "utf8")),
      );
      if (parsed.success) records = parsed.data.records;
      else this.logger.error({ agentId }, "Invalid sent attachments file");
    } catch (error) {
      if (!isMissingFile(error)) {
        this.logger.error({ err: error, agentId }, "Failed to read sent attachments");
      }
    }
    this.cache.set(agentId, records);
    return records;
  }

  private async persist(agentId: string, records: SentAttachmentRecord[]): Promise<void> {
    const target = this.filePath(agentId);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, records }), { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  private filePath(agentId: string): string {
    if (!AGENT_ID_PATTERN.test(agentId) || agentId === "." || agentId === "..") {
      throw new Error("Invalid agent id");
    }
    return path.join(this.directory, `${agentId}.json`);
  }
}

/** Matches replayed user messages to the records of what they carried. */
export class SentAttachmentJoiner {
  private readonly used = new Set<string>();

  constructor(private readonly records: readonly SentAttachmentRecord[]) {}

  /**
   * Returns the record a replayed user message belongs to, or null. Each record matches once.
   * Ids decide when the provider replays one; only a message with no client id falls back to
   * the typed text, and only against records no provider id was recorded for.
   */
  match(item: {
    text: string;
    messageId?: string;
    clientMessageId?: string;
  }): SentAttachmentRecord | null {
    const unused = this.records.filter((record) => !this.used.has(record.clientMessageId));
    let found: SentAttachmentRecord | undefined;
    if (item.clientMessageId) {
      found = unused.find((record) => record.clientMessageId === item.clientMessageId);
    } else {
      if (item.messageId) {
        found = unused.find((record) => record.providerMessageId === item.messageId);
      }
      found ??= unused.find(
        (record) => !record.providerMessageId && this.matchesText(record, item.text),
      );
    }
    if (!found) return null;
    this.used.add(found.clientMessageId);
    return found;
  }

  private matchesText(record: SentAttachmentRecord, replayed: string): boolean {
    if (record.text.length > 0) return replayed.startsWith(record.text);
    // Nothing was typed: only a message that contains every attachment body is this one.
    return (
      record.attachments.some(
        (attachment) => attachment.type === "text" && attachment.text.length > 0,
      ) &&
      record.attachments.every(
        (attachment) =>
          attachment.type !== "text" || replayed.includes(attachment.text.slice(0, 200)),
      )
    );
  }
}
