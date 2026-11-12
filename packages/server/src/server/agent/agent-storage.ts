import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import { runJsonImportOnce, type PimiDatabase } from "../db/pimi-db.js";
import { AgentFeatureSchema, AgentStatusSchema } from "../messages.js";
import { AgentUsageSchema } from "@pimi/protocol/messages";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    providerOptions: z.record(z.string(), z.unknown()).nullable().optional(),
    toolPolicy: z
      .object({
        preapproved: z.array(
          z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string() }).strict(),
        ),
      })
      .strict()
      .nullable()
      .optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
    profile: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .nullable()
  .optional();

const STORED_AGENT_SCHEMA = z.object({
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  initialChatContext: z.string().optional(),
  pendingProviderContext: z.string().optional(),
  title: z.string().nullable().optional(),
  provisionalTitle: z.boolean().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  lastStatus: AgentStatusSchema.default("closed"),
  resumeOnStartup: z.boolean().optional(),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  launchEnv: z.record(z.string(), z.string()).optional(),
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  lastError: z.string().nullable().optional(),
  lastUsage: AgentUsageSchema.optional().catch(undefined),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  background: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "featureValues"
  | "providerOptions"
  | "toolPolicy"
  | "systemPrompt"
  | "mcpServers"
  | "profile"
>;

export type StoredAgentRecord = z.infer<typeof STORED_AGENT_SCHEMA>;
export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return STORED_AGENT_SCHEMA.parse(value);
}

/** Context a snapshot keeps from the stored record when the live agent does not carry it. */
function previousConversationContext(existing: StoredAgentRecord | null | undefined) {
  return {
    previousInitialChatContext: existing?.initialChatContext,
    previousPendingProviderContext: existing?.pendingProviderContext,
  };
}

type Row = Record<string, string | number | bigint | null | Uint8Array>;

const IN_CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

const SELECT_RECORDS =
  "SELECT a.id AS id, a.json AS json, p.json AS persistence FROM agents a LEFT JOIN agent_persistence p ON p.agent_id = a.id";

// Agent records live in pimi.db: `agents` holds the record minus `persistence` plus indexed columns,
// `agent_persistence` holds the provider resume handle. Every call is one synchronous statement or
// transaction, so there is no in-memory copy and no write queue. A legacy
// $PIMI_HOME/agents/<cwd-dir>/<id>.json tree is imported once and renamed to `agents.migrated`.
export class AgentStorage {
  private readonly deleting = new Set<string>();
  private readonly database: PimiDatabase;
  private readonly legacyDir: string;
  private readonly logger: Logger;

  constructor(database: PimiDatabase, legacyDir: string, logger: Logger) {
    this.database = database;
    this.legacyDir = legacyDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  async initialize(): Promise<void> {
    const records = await this.readLegacyRecords();
    await runJsonImportOnce(
      this.database,
      { name: "agents", legacyPaths: [this.legacyDir], logger: this.logger },
      () => {
        // The same id can sit in two cwd directories after a cwd change; the newest wins.
        const newest = new Map<string, StoredAgentRecord>();
        for (const record of records) {
          const seen = newest.get(record.id);
          if (!seen || record.updatedAt > seen.updatedAt) newest.set(record.id, record);
        }
        for (const record of newest.values()) this.writeRecord(record);
        this.logger.info({ count: newest.size }, "Importing legacy agent records");
      },
    );
  }

  private query(sql: string, params: string[] = []): StoredAgentRecord[] {
    const records: StoredAgentRecord[] = [];
    for (const row of this.database.db.prepare(sql).all(...params) as Row[]) {
      try {
        const value = JSON.parse(String(row.json));
        if (row.persistence !== null && row.persistence !== undefined) {
          value.persistence = JSON.parse(String(row.persistence));
        }
        records.push(parseStoredAgentRecord(value));
      } catch (error) {
        this.logger.error({ err: error, agentId: row.id }, "Skipping invalid agent record");
      }
    }
    return records;
  }

  async listAll(): Promise<StoredAgentRecord[]> {
    return this.query(`${SELECT_RECORDS} ORDER BY a.rowid`);
  }

  async listActive(options?: { includeArchived?: boolean }): Promise<StoredAgentRecord[]> {
    return this.query(
      `${SELECT_RECORDS}${options?.includeArchived ? "" : " WHERE a.archived_at IS NULL"} ORDER BY a.rowid`,
    );
  }

  async listByWorkspaces(
    workspaceIds: Iterable<string>,
    options?: { includeArchived?: boolean },
  ): Promise<StoredAgentRecord[]> {
    const ids = [...new Set(workspaceIds)];
    const order = new Map(ids.map((id, index) => [id, index]));
    const records: StoredAgentRecord[] = [];
    for (const group of chunks(ids)) {
      records.push(
        ...this.query(
          `${SELECT_RECORDS} WHERE a.workspace_id IN (${group.map(() => "?").join(",")})${
            options?.includeArchived ? "" : " AND a.archived_at IS NULL"
          } ORDER BY a.rowid`,
          group,
        ),
      );
    }
    return records.sort(
      (a, b) => (order.get(a.workspaceId ?? "") ?? 0) - (order.get(b.workspaceId ?? "") ?? 0),
    );
  }

  async lastUserMessageAtByWorkspace(
    workspaceIds?: Iterable<string>,
    options?: { excludeAgentIds?: Iterable<string> },
  ): Promise<ReadonlyMap<string, string>> {
    const excluded = [...new Set(options?.excludeAgentIds)];
    const times = new Map<string, string>();
    for (const group of workspaceIds ? chunks([...new Set(workspaceIds)]) : [null]) {
      const sql =
        "SELECT workspace_id, MAX(last_user_message_at) AS at FROM agents " +
        "WHERE workspace_id IS NOT NULL AND internal = 0 AND background = 0 AND last_user_message_at IS NOT NULL" +
        (group ? ` AND workspace_id IN (${group.map(() => "?").join(",")})` : "") +
        (excluded.length ? ` AND id NOT IN (${excluded.map(() => "?").join(",")})` : "") +
        " GROUP BY workspace_id";
      for (const row of this.database.db.prepare(sql).all(...(group ?? []), ...excluded) as Row[]) {
        if (row.at) times.set(String(row.workspace_id), String(row.at));
      }
    }
    return times;
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    return this.query(`${SELECT_RECORDS} WHERE a.id = ?`, [agentId])[0] ?? null;
  }

  async listByProviderSession(
    provider: string,
    providerHandleId: string,
  ): Promise<StoredAgentRecord[]> {
    return this.query(
      `${SELECT_RECORDS} WHERE a.persistence_provider = ? AND (a.provider_session_id = ? OR a.provider_native_handle = ?) ORDER BY a.rowid`,
      [provider, providerHandleId, providerHandleId],
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    return this.listByWorkspaces([workspaceId], { includeArchived: true });
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    this.mutate(record.id, () => record);
  }

  // Reads, mutates and writes one record in a single transaction. A record being deleted is never
  // written back.
  private mutate(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord | null,
  ): StoredAgentRecord | null {
    if (this.deleting.has(agentId)) return null;
    return this.database.transaction(() => {
      const existing = this.query(`${SELECT_RECORDS} WHERE a.id = ?`, [agentId])[0] ?? null;
      const record = mutate(existing);
      if (record) this.writeRecord(record);
      return record;
    });
  }

  private writeRecord(record: StoredAgentRecord): void {
    const { persistence, ...rest } = record;
    const native =
      persistence && typeof persistence.nativeHandle === "string" ? persistence.nativeHandle : null;
    const prepared = (sql: string) => this.database.db.prepare(sql);
    prepared(
      `INSERT INTO agents (id, workspace_id, provider, cwd, archived_at, internal, background,
         updated_at, last_user_message_at, persistence_provider, provider_session_id,
         provider_native_handle, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id,
         provider = excluded.provider, cwd = excluded.cwd, archived_at = excluded.archived_at,
         internal = excluded.internal, background = excluded.background,
         updated_at = excluded.updated_at, last_user_message_at = excluded.last_user_message_at,
         persistence_provider = excluded.persistence_provider,
         provider_session_id = excluded.provider_session_id,
         provider_native_handle = excluded.provider_native_handle, json = excluded.json`,
    ).run(
      record.id,
      record.workspaceId ?? null,
      record.provider,
      record.cwd,
      record.archivedAt || null,
      record.internal ? 1 : 0,
      record.background ? 1 : 0,
      record.updatedAt,
      record.lastUserMessageAt ?? null,
      persistence?.provider ?? null,
      persistence?.sessionId ?? null,
      native,
      JSON.stringify(rest),
    );
    if (persistence === undefined) {
      prepared("DELETE FROM agent_persistence WHERE agent_id = ?").run(record.id);
    } else {
      prepared(
        "INSERT INTO agent_persistence (agent_id, json) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET json = excluded.json",
      ).run(record.id, JSON.stringify(persistence));
    }
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    this.beginDelete(agentId);
    this.database.db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; provisionalTitle?: boolean; internal?: boolean },
  ): Promise<void> {
    const titleOverride =
      options && Object.prototype.hasOwnProperty.call(options, "title")
        ? (options.title ?? null)
        : undefined;
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    this.mutate(agent.id, (existing) => {
      const record = toStoredAgentRecord(agent, {
        title: titleOverride === undefined ? (existing?.title ?? null) : titleOverride,
        createdAt: existing?.createdAt,
        internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
        ...previousConversationContext(existing),
      });
      record.provisionalTitle = options?.provisionalTitle ?? existing?.provisionalTitle;

      // Preserve soft-delete/archive status across snapshot flushes.
      if (existing && existing.archivedAt !== undefined) {
        record.archivedAt = existing.archivedAt;
      }
      // Background is fixed at creation; a runtime opened without it cannot clear it.
      if (existing?.background) record.background = true;
      record.resumeOnStartup =
        existing?.resumeOnStartup && agent.lifecycle !== "idle" && agent.lifecycle !== "error";
      return record;
    });
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    const record = await this.updateRecord(agentId, (current) => ({
      ...current,
      title,
      provisionalTitle: undefined,
    }));
    if (!record) throw new Error(`Agent ${agentId} not found`);
  }

  async updateRecord(
    agentId: string,
    mutate: (current: StoredAgentRecord) => StoredAgentRecord | null,
  ): Promise<StoredAgentRecord | null> {
    return this.mutate(agentId, (current) => (current ? mutate(current) : null));
  }

  // Writes are synchronous and committed when the call returns; kept for shutdown callers.
  async flush(): Promise<void> {}

  private async readLegacyRecords(): Promise<StoredAgentRecord[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.legacyDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(path.join(this.legacyDir, entry.name));
      } else if (entry.isDirectory()) {
        const dir = path.join(this.legacyDir, entry.name);
        for (const file of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (file.isFile() && file.name.endsWith(".json")) files.push(path.join(dir, file.name));
        }
      }
    }
    const records: StoredAgentRecord[] = [];
    for (const filePath of files) {
      try {
        records.push(parseStoredAgentRecord(JSON.parse(await fs.readFile(filePath, "utf8"))));
      } catch (error) {
        this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      }
    }
    return records;
  }
}
