import type { Logger } from "pino";
import {
  CHAT_SEARCH_LIMITS,
  type ChatSearchHit,
  type ChatSearchKind,
  type ChatSearchRequest,
  type ChatSearchResponse,
} from "@pimi/protocol/chat-search";
import type { AgentStorage } from "../agent-storage.js";
import type { PimiDatabase } from "../../db/pimi-db.js";
import type { SqliteTimelineStore } from "../sqlite-timeline-store.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import { parseChatQuery, SNIPPET_CLOSE, SNIPPET_OPEN, splitSnippet } from "./query.js";

const ALL_KINDS: readonly ChatSearchKind[] = ["user", "assistant", "tool"];
/** Words of context on each side of a match in a snippet, as FTS5 counts tokens. */
const SNIPPET_TOKENS = 24;

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isInteger(offset) && offset >= 0
    ? Math.min(offset, CHAT_SEARCH_LIMITS.maxOffset)
    : 0;
}

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

/** Answers `chat.search.request` from the full-text index in pimi-timeline.db. */
export class ChatSearchService {
  private readonly logger: Logger;

  constructor(
    private readonly options: {
      store: SqliteTimelineStore;
      agentStorage: Pick<AgentStorage, "get">;
      workspaceRegistry: Pick<WorkspaceRegistry, "listActive">;
      /** pimi.db, for scope and archive filters. */
      agentsDb: PimiDatabase;
      logger: Logger;
    },
  ) {
    this.logger = options.logger.child({ module: "agent", component: "chat-search" });
  }

  /** How many chats can be searched, out of how many exist. */
  indexStatus(): ChatSearchResponse["index"] {
    const total = this.options.agentsDb.db
      .prepare("SELECT COUNT(*) AS count FROM agents WHERE internal = 0")
      .get();
    const indexed = this.options.store.database.db
      .prepare(
        "SELECT COUNT(*) AS count FROM timeline_agents WHERE complete = 1 AND indexed_hi > 0",
      )
      .get();
    return {
      indexedChats: Number(indexed?.count ?? 0),
      totalChats: Number(total?.count ?? 0),
    };
  }

  async search(request: ChatSearchRequest): Promise<ChatSearchResponse> {
    const empty = (error: string | null): ChatSearchResponse => ({
      requestId: request.requestId,
      hits: [],
      nextCursor: null,
      index: this.indexStatus(),
      error,
    });
    const parsed = parseChatQuery(request.query);
    if (!parsed.ok) return empty(parsed.reason);
    try {
      return await this.run(request, parsed.match, empty);
    } catch (error) {
      this.logger.error({ err: error }, "chat.search failed");
      return empty(error instanceof Error ? error.message : String(error));
    }
  }

  private async run(
    request: ChatSearchRequest,
    match: string,
    empty: (error: string | null) => ChatSearchResponse,
  ): Promise<ChatSearchResponse> {
    const limit = request.limit ?? CHAT_SEARCH_LIMITS.defaultLimit;
    const offset = decodeOffset(request.cursor);
    const where: string[] = ["timeline_fts MATCH ?"];
    const params: Array<string | number> = [match];

    const kinds = request.kinds?.length ? request.kinds : ALL_KINDS;
    if (kinds.length < ALL_KINDS.length) {
      where.push(`d.kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    }
    const allowed = await this.allowedAgentIds(request);
    if (allowed) {
      if (allowed.length === 0) return empty(null);
      where.push(`a.agent_id IN (${allowed.map(() => "?").join(",")})`);
      params.push(...allowed);
    }
    if (request.includeArchived === false) {
      const archived = this.options.agentsDb.db
        .prepare("SELECT id FROM agents WHERE archived_at IS NOT NULL")
        .all()
        .map((row) => String(row.id));
      if (archived.length > 0) {
        where.push(`a.agent_id NOT IN (${archived.map(() => "?").join(",")})`);
        params.push(...archived);
      }
    }

    const order = request.sort === "recent" ? "d.ts DESC" : "bm25(timeline_fts)";
    const rows = this.options.store.database.db
      .prepare(
        `SELECT a.agent_id AS agent_id, a.epoch AS epoch, d.seq_start AS seq_start,
                d.seq_end AS seq_end, d.kind AS kind, d.ts AS ts,
                snippet(timeline_fts, 0, ?, ?, '…', ${SNIPPET_TOKENS}) AS snip
           FROM timeline_fts
           JOIN timeline_docs d ON d.id = timeline_fts.rowid
           JOIN timeline_agents a ON a.key = d.agent_key
          WHERE ${where.join(" AND ")}
          ORDER BY ${order}
          LIMIT ? OFFSET ?`,
      )
      .all(SNIPPET_OPEN, SNIPPET_CLOSE, ...params, limit + 1, offset);

    const hits: ChatSearchHit[] = [];
    for (const row of rows.slice(0, limit)) {
      const record = await this.options.agentStorage.get(String(row.agent_id));
      // The chat was deleted after the row was indexed; the sweep will remove its rows.
      if (!record) continue;
      hits.push({
        agentId: record.id,
        title: record.title ?? null,
        provider: record.provider,
        workspaceId: record.workspaceId ?? null,
        archived: Boolean(record.archivedAt),
        epoch: String(row.epoch),
        seq: Number(row.seq_end),
        seqStart: Number(row.seq_start),
        kind: row.kind as ChatSearchKind,
        timestamp: String(row.ts),
        snippet: splitSnippet(String(row.snip)),
      });
    }
    const next = offset + limit;
    return {
      requestId: request.requestId,
      hits,
      nextCursor:
        rows.length > limit && next <= CHAT_SEARCH_LIMITS.maxOffset ? encodeOffset(next) : null,
      index: this.indexStatus(),
      error: null,
    };
  }

  /** The agent ids a scope allows, or null when the request has no scope. */
  private async allowedAgentIds(request: ChatSearchRequest): Promise<string[] | null> {
    const scope = request.scope;
    if (!scope) return null;
    if (scope.agentId) return [scope.agentId];
    let workspaceIds: string[] | null = null;
    if (scope.workspaceId) workspaceIds = [scope.workspaceId];
    else if (scope.projectId) {
      const active = await this.options.workspaceRegistry.listActive();
      workspaceIds = active
        .filter((workspace) => workspace.projectId === scope.projectId)
        .map((workspace) => workspace.workspaceId);
    }
    if (!workspaceIds) return null;
    if (workspaceIds.length === 0) return [];
    return this.options.agentsDb.db
      .prepare(
        `SELECT id FROM agents WHERE internal = 0 AND workspace_id IN (${workspaceIds.map(() => "?").join(",")})`,
      )
      .all(...workspaceIds)
      .map((row) => String(row.id));
  }
}
