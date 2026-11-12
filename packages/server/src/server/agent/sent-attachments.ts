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
import { runJsonImportOnce, type PimiDatabase } from "../db/pimi-db.js";
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

// Rows of the sent_attachments table, one per sent message, in send order (rowid).
export class SqlSentAttachmentStore implements SentAttachmentStore {
  private readonly logger: Logger;

  constructor(
    private readonly database: PimiDatabase,
    private readonly legacyDirectory: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "agent", component: "sent-attachments" });
  }

  // The old agent-sent-attachments/<agentId>.json files are imported once and the directory is
  // renamed to agent-sent-attachments.migrated.
  async importLegacy(): Promise<void> {
    const items: Array<{ agentId: string; records: SentAttachmentRecord[] }> = [];
    let names: string[] = [];
    try {
      names = await fs.readdir(this.legacyDirectory);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
      try {
        const parsed = FILE_SCHEMA.parse(
          JSON.parse(await fs.readFile(path.join(this.legacyDirectory, name), "utf8")),
        );
        items.push({ agentId: name.slice(0, -".json".length), records: parsed.records });
      } catch (error) {
        this.logger.error({ err: error, name }, "Skipping invalid sent attachments file");
      }
    }
    await runJsonImportOnce(
      this.database,
      { name: "sent-attachments", legacyPaths: [this.legacyDirectory], logger: this.logger },
      () => {
        for (const item of items) {
          for (const record of item.records) this.insert(item.agentId, record);
        }
      },
    );
  }

  private insert(agentId: string, record: SentAttachmentRecord): void {
    this.database.db
      .prepare(
        "INSERT OR IGNORE INTO sent_attachments (agent_id, message_id, json) VALUES (?, ?, ?)",
      )
      .run(agentId, record.clientMessageId, JSON.stringify(record));
  }

  async load(agentId: string): Promise<readonly SentAttachmentRecord[]> {
    const rows = this.database.db
      .prepare("SELECT json FROM sent_attachments WHERE agent_id = ? ORDER BY rowid")
      .all(agentId);
    const records: SentAttachmentRecord[] = [];
    for (const row of rows) {
      const parsed = RECORD_SCHEMA.safeParse(JSON.parse(String(row.json)));
      if (parsed.success) records.push(parsed.data);
      else this.logger.error({ agentId }, "Invalid sent attachment record");
    }
    return records;
  }

  async append(agentId: string, record: SentAttachmentRecord): Promise<void> {
    this.insert(agentId, RECORD_SCHEMA.parse(record));
  }

  async setProviderMessageId(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): Promise<void> {
    this.database.transaction(() => {
      const row = this.database.db
        .prepare("SELECT json FROM sent_attachments WHERE agent_id = ? AND message_id = ?")
        .get(agentId, clientMessageId);
      if (!row) return;
      const record = RECORD_SCHEMA.parse(JSON.parse(String(row.json)));
      if (record.providerMessageId === providerMessageId) return;
      this.database.db
        .prepare("UPDATE sent_attachments SET json = ? WHERE agent_id = ? AND message_id = ?")
        .run(JSON.stringify({ ...record, providerMessageId }), agentId, clientMessageId);
    });
  }

  async delete(agentId: string): Promise<void> {
    this.database.db.prepare("DELETE FROM sent_attachments WHERE agent_id = ?").run(agentId);
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
