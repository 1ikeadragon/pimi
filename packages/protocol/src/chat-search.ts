import { z } from "zod";

// Cross-chat message search (`chat.search.*`). The daemon keeps a full-text index of what was
// said in every chat (user text, assistant text, and the name and input of tool calls). A hit
// carries the `epoch` and `seq` of the entry it matched, which is the address the app scrolls to.
export const CHAT_SEARCH_LIMITS = {
  minQueryLength: 2,
  maxQueryLength: 256,
  defaultLimit: 30,
  maxLimit: 100,
  /** Paging stops here; a longer list is a query that is too broad to be useful. */
  maxOffset: 500,
} as const;

export const ChatSearchKindSchema = z.enum(["user", "assistant", "tool"]);

export const ChatSearchRequestSchema = z.object({
  type: z.literal("chat.search.request"),
  requestId: z.string(),
  // 2..256 characters after trimming; checked by the daemon so the reply can say why.
  query: z.string().max(CHAT_SEARCH_LIMITS.maxQueryLength * 4),
  scope: z
    .object({
      workspaceId: z.string().optional(),
      projectId: z.string().optional(),
      agentId: z.string().optional(),
    })
    .optional(),
  kinds: z.array(ChatSearchKindSchema).optional(),
  includeArchived: z.boolean().optional(),
  sort: z.enum(["relevance", "recent"]).optional(),
  limit: z.number().int().min(1).max(CHAT_SEARCH_LIMITS.maxLimit).optional(),
  // Opaque; returned as `nextCursor`.
  cursor: z.string().max(64).optional(),
});

const ChatSearchHitSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  workspaceId: z.string().nullable(),
  archived: z.boolean(),
  epoch: z.string(),
  // The last row of the matched entry: the jump target. `seqStart` is its first row.
  seq: z.number().int(),
  seqStart: z.number().int(),
  kind: ChatSearchKindSchema,
  timestamp: z.string(),
  snippet: z.object({
    text: z.string(),
    // [start, end) in UTF-16 units of `text`.
    ranges: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])),
  }),
});

const ChatSearchIndexStatusSchema = z.object({
  indexedChats: z.number().int().min(0),
  totalChats: z.number().int().min(0),
});

export const ChatSearchResponseMessageSchema = z.object({
  type: z.literal("chat.search.response"),
  payload: z.object({
    requestId: z.string(),
    hits: z.array(ChatSearchHitSchema),
    nextCursor: z.string().nullable(),
    index: ChatSearchIndexStatusSchema,
    error: z.string().nullable(),
  }),
});

// Starts, or reports on, the run that reads chats nobody opened since the index existed.
export const ChatSearchIndexRequestSchema = z.object({
  type: z.literal("chat.search.index.request"),
  requestId: z.string(),
  action: z.enum(["start", "status"]),
});

export const ChatSearchIndexResponseMessageSchema = z.object({
  type: z.literal("chat.search.index.response"),
  payload: z.object({
    requestId: z.string(),
    running: z.boolean(),
    done: z.number().int().min(0),
    total: z.number().int().min(0),
    // Chats the run could not read (provider missing, session gone), with the reason.
    skipped: z.array(z.object({ agentId: z.string(), reason: z.string() })),
    error: z.string().nullable(),
  }),
});

export type ChatSearchKind = z.infer<typeof ChatSearchKindSchema>;
export type ChatSearchRequest = z.infer<typeof ChatSearchRequestSchema>;
export type ChatSearchHit = z.infer<typeof ChatSearchHitSchema>;
export type ChatSearchResponse = z.infer<typeof ChatSearchResponseMessageSchema>["payload"];
export type ChatSearchIndexRequest = z.infer<typeof ChatSearchIndexRequestSchema>;
export type ChatSearchIndexResponse = z.infer<
  typeof ChatSearchIndexResponseMessageSchema
>["payload"];
