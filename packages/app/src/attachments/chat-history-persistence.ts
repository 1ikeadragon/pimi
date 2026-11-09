import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { z } from "zod";
import { TextAttachmentSchema } from "@pimi/protocol/messages";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { AttachmentMetadataSchema } from "@/stores/draft-store/state";
import { retainAttachmentForGarbageCollection, trackAttachmentRetentionRead } from "./gc-retention";
import { persistAttachmentFromBytes } from "./service";
import { getAttachmentStore } from "./store";
import type { AttachmentMetadata, ChatHistoryContextAttachment } from "./types";

const ChatHistorySchema: z.ZodType<ChatHistoryContextAttachment> = z.strictObject({
  kind: z.literal("chat_history"),
  id: z.string(),
  attachment: TextAttachmentSchema,
  source: z.strictObject({
    serverId: z.string(),
    agentId: z.string(),
    boundaryMessageId: z.string().nullable().optional(),
    boundaryCursor: z.strictObject({ epoch: z.string(), seq: z.number() }).nullable().optional(),
    itemCount: z.number().optional(),
    providerLabel: z.string().optional(),
    providerId: z.string().optional(),
    truncated: z.boolean().optional(),
  }),
});

export interface PersistedChatHistory {
  attachmentsByScope: Record<string, ChatHistoryContextAttachment[]>;
}

interface StoredScope {
  attachments: ChatHistoryContextAttachment[];
  metadata: AttachmentMetadata;
  release: () => void;
}

// History bodies can be large. Keep them in the platform attachment store, with
// only a small metadata index in AsyncStorage (which has native row-size limits).
export interface ChatHistoryPersistStorage extends PersistStorage<PersistedChatHistory> {
  flush: () => Promise<void>;
}

export function createChatHistoryPersistStorage(): ChatHistoryPersistStorage {
  const index = createValidatedPersistStorage(
    AsyncStorage,
    z.record(z.string(), AttachmentMetadataSchema),
  );
  let scopes = new Map<string, StoredScope>();
  let tail: Promise<unknown> = Promise.resolve();
  let latest: Promise<unknown> = tail;
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    latest = result;
    // A failed write must not block the next save; its caller still receives the error.
    tail = result.catch(() => undefined);
    return result;
  }
  async function discard(entries: Iterable<StoredScope>) {
    const store = await getAttachmentStore();
    for (const entry of entries) {
      entry.release();
      await store.delete({ attachment: entry.metadata });
    }
  }
  return {
    flush: async () => {
      await latest;
    },
    getItem: (name) => {
      // Register all persisted ids before decoding bodies. GC may run concurrently
      // with hydration of the ordinary composer draft store.
      const read = trackAttachmentRetentionRead(
        Promise.resolve(index.getItem(name)).then((stored) => ({
          stored,
          releases: new Map(
            Object.entries(stored?.state ?? {}).map(([scope, metadata]) => [
              scope,
              retainAttachmentForGarbageCollection(metadata.id),
            ]),
          ),
        })),
      );
      return serial(async () => {
        const { stored, releases } = await read;
        if (!stored) return null;
        const store = await getAttachmentStore();
        const restored: PersistedChatHistory = { attachmentsByScope: {} };
        for (const [scope, metadata] of Object.entries(stored.state)) {
          const release = releases.get(scope)!;
          try {
            const base64 = await store.encodeBase64({ attachment: metadata });
            const text = new TextDecoder().decode(
              Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
            );
            const attachments = z.array(ChatHistorySchema).parse(JSON.parse(text));
            scopes.get(scope)?.release();
            scopes.set(scope, { attachments, metadata, release });
            restored.attachmentsByScope[scope] = attachments;
          } catch (error) {
            release();
            scopes.get(scope)?.release();
            scopes.delete(scope);
            // Error messages from JSON/schema parsers may contain the chat body.
            console.warn("[ChatHistory] Could not restore draft history", {
              scope,
              attachmentId: metadata.id,
              reason: error instanceof Error ? error.name : "UnknownError",
            });
          }
        }
        if (Object.keys(restored.attachmentsByScope).length !== Object.keys(stored.state).length) {
          await index.setItem(name, {
            state: Object.fromEntries([...scopes].map(([scope, entry]) => [scope, entry.metadata])),
            version: stored.version,
          });
        }
        return { state: restored, version: stored.version };
      });
    },
    setItem: (name, value) =>
      serial(async () => {
        const next = new Map<string, StoredScope>();
        const created: StoredScope[] = [];
        try {
          for (const [scope, attachments] of Object.entries(value.state.attachmentsByScope)) {
            const existing = scopes.get(scope);
            if (
              existing &&
              attachments.length === existing.attachments.length &&
              attachments.every((attachment, i) => attachment === existing.attachments[i])
            ) {
              next.set(scope, existing);
              continue;
            }
            const metadata = await persistAttachmentFromBytes({
              bytes: new TextEncoder().encode(JSON.stringify(attachments)),
              mimeType: "application/json",
              fileName: "chat-history.json",
            });
            const entry = {
              attachments,
              metadata,
              release: retainAttachmentForGarbageCollection(metadata.id),
            };
            created.push(entry);
            next.set(scope, entry);
          }
          const saved: StorageValue<Record<string, AttachmentMetadata>> = {
            state: Object.fromEntries([...next].map(([scope, entry]) => [scope, entry.metadata])),
            version: value.version,
          };
          await index.setItem(name, saved);
        } catch (error) {
          await discard(created);
          throw error;
        }
        const removed = [...scopes]
          .filter(([scope, entry]) => next.get(scope) !== entry)
          .map(([, entry]) => entry);
        scopes = next;
        await discard(removed);
      }),
    removeItem: (name) =>
      serial(async () => {
        await index.removeItem(name);
        const removed = scopes;
        scopes = new Map();
        await discard(removed.values());
      }),
  };
}
