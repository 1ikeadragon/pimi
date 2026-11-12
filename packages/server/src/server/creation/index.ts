import type { Logger } from "pino";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CreationSnapshotSchema,
  type AgentSnapshotPayload,
  type CreationSnapshot,
  type WorkspaceDescriptorPayload,
} from "@pimi/protocol/messages";
import { runJsonImportOnce, type PimiDatabase } from "../db/pimi-db.js";
import { generateWorkspaceId } from "../workspace-registry-model.js";

type Observer = (snapshot: CreationSnapshot) => void;
export interface CreatedAgent {
  agent: AgentSnapshotPayload;
  initialPromptStarted: boolean;
}
interface CreationRequest {
  key: string;
  request: { [key: string]: unknown };
  workspaceId?: string;
  agentId?: string;
  hasAgent: boolean;
  hasPrompt: boolean;
  exists: (kind: "workspace" | "agent", id: string) => Promise<boolean>;
  provision?: (
    workspaceId: string,
  ) => Promise<{ workspace: WorkspaceDescriptorPayload; setupSkippedReason?: string }>;
  createAgent?: (
    agentId: string,
    workspace: WorkspaceDescriptorPayload | undefined,
    onReady: (agent: AgentSnapshotPayload) => Promise<void>,
  ) => Promise<CreatedAgent>;
}
export type CreationInput = CreationRequest &
  (
    | { kind: "workspace" }
    | { kind: "agent"; readAgent: (id: string) => Promise<AgentSnapshotPayload | null> }
  );
const RecordSchema = z.object({
  fingerprint: z.string(),
  snapshot: CreationSnapshotSchema,
  inFlight: z.enum(["workspace", "agent", "prompt"]).nullable(),
});
type Record = z.infer<typeof RecordSchema>;

// A creation receipt (and the id claims it owns) only has to outlive client retries of the same
// idempotency key: reconnects and offline queues, hours to days. 30 days leaves a wide margin.
// Without it the directory gains about 2.4 files per agent forever.
const CREATION_RETENTION_MS = 30 * 24 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

/** Owns creation across socket lifetimes. Resource owners perform work; this module commits its milestones. */
export class CreationService {
  private admission: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, Promise<CreationSnapshot>>();
  private readonly observers = new Map<string, Set<Observer>>();
  private lastPruneAt = 0;
  constructor(
    private readonly database: PimiDatabase,
    private readonly legacyDirectory: string,
    private readonly logger: Logger,
    private readonly validateCompleted: (
      snapshot: CreationSnapshot,
    ) => Promise<void> = async () => {},
  ) {}

  async create(input: CreationInput, observer?: Observer): Promise<CreationSnapshot> {
    const identity = identityFor(input.kind, input.key);
    const admitted = this.admission.then(async () => {
      await this.pruneIfDue();
      const fingerprint = digest(input.request);
      let record = await this.read(identity);
      if (record && record.fingerprint !== fingerprint)
        throw new Error(`${input.kind}_request_key_conflict`);
      const running = this.active.get(identity);
      if (running && record) return { completion: running, snapshot: record.snapshot };
      if (record?.snapshot.phase === "completed") await this.validateCompleted(record.snapshot);
      if (record?.snapshot.phase === "completed" || record?.snapshot.outcomeUnknown) {
        return { completion: Promise.resolve(record.snapshot), snapshot: record.snapshot };
      }
      if (record?.inFlight) {
        await this.publish(identity, record, {
          phase: "failed",
          error: `${input.kind}_request_outcome_unknown`,
          failedStage: record.inFlight,
          outcomeUnknown: true,
        });
        return { completion: Promise.resolve(record.snapshot), snapshot: record.snapshot };
      }
      if (!record) {
        record = initialRecord(input, fingerprint);
        // Persist identity before claiming resources. A failed admission can only retry these IDs.
        await this.write(identity, record);
      }
      await this.claimResources(identity, record.snapshot, input);
      if (record.snapshot.phase === "failed") {
        await this.publish(identity, record, {
          phase: record.snapshot.workspace ? "workspace_ready" : "accepted",
          error: null,
          errorCode: undefined,
          failedStage: undefined,
          outcomeUnknown: undefined,
        });
      }
      const snapshot = record.snapshot;
      // Defer the runner until admission has installed the initiating observer.
      const completion = Promise.resolve().then(() => this.run(identity, record, input));
      this.active.set(identity, completion);
      void completion.finally(() => this.active.delete(identity)).catch(() => undefined);
      return { completion, snapshot };
    });
    this.admission = admitted.then(
      () => undefined,
      () => undefined,
    );
    // Install before admission starts, so even a fast local provision cannot outrun observation.
    const unsubscribe = observer ? this.observe(identity, observer) : () => {};
    try {
      const { completion, snapshot } = await admitted;
      if (observer) this.notify(observer, snapshot);
      return await completion;
    } finally {
      unsubscribe();
    }
  }

  // Lazy and inside admission, so it never races a claim; a daemon that creates nothing has
  // nothing growing. A failed prune is logged and does not block the creation.
  private async pruneIfDue(): Promise<void> {
    if (Date.now() - this.lastPruneAt <= PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = Date.now();
    try {
      const removed = await this.prune(Date.now());
      if (removed > 0) this.logger.info({ removed }, "Pruned old creation receipts");
    } catch (err) {
      this.logger.warn({ err }, "Failed to prune creation receipts");
    }
  }

  // Deletes receipts untouched for CREATION_RETENTION_MS, except one that is running, then the
  // claims whose receipt is gone. A claim whose receipt still exists stays however old it is.
  async prune(now: number): Promise<number> {
    const db = this.database.db;
    const cutoff = now - CREATION_RETENTION_MS;
    let removed = 0;
    const stale = db
      .prepare("SELECT identity FROM receipts WHERE kind = 'creation' AND updated_at < ?")
      .all(cutoff) as Array<{ identity: string }>;
    for (const { identity } of stale) {
      if (this.active.has(identity)) continue;
      db.prepare("DELETE FROM receipts WHERE kind = 'creation' AND identity = ?").run(identity);
      removed += 1;
    }
    removed += Number(
      db
        .prepare(
          `DELETE FROM receipts WHERE kind = 'creation_claim' AND updated_at < ?
             AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.kind = 'creation'
                             AND r.identity = json_extract(receipts.json, '$'))`,
        )
        .run(cutoff).changes,
    );
    return removed;
  }

  // The old $PIMI_HOME/creations tree (<identity>.json receipts, <hash>.claim owner files) is
  // imported once with its file times and renamed to creations.migrated.
  async importLegacy(): Promise<void> {
    const receipts: Array<{ identity: string; record: Record; at: number }> = [];
    const claims: Array<{ hash: string; owner: string; at: number }> = [];
    let names: string[] = [];
    try {
      names = await readdir(this.legacyDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of names) {
      const file = join(this.legacyDirectory, name);
      try {
        if (name.endsWith(".json")) {
          const record = RecordSchema.parse(JSON.parse(await readFile(file, "utf8")));
          receipts.push({
            identity: name.slice(0, -".json".length),
            record,
            at: (await stat(file)).mtimeMs,
          });
        } else if (name.endsWith(".claim")) {
          claims.push({
            hash: name.slice(0, -".claim".length),
            owner: (await readFile(file, "utf8")).trim(),
            at: (await stat(file)).mtimeMs,
          });
        }
      } catch (err) {
        this.logger.error({ err, file }, "Skipping invalid creation receipt file");
      }
    }
    await runJsonImportOnce(
      this.database,
      { name: "creations", legacyPaths: [this.legacyDirectory], logger: this.logger },
      () => {
        for (const item of receipts) this.store("creation", item.identity, item.record, item.at);
        for (const item of claims) this.store("creation_claim", item.hash, item.owner, item.at);
      },
    );
  }

  async subscribe(
    kind: CreationSnapshot["kind"],
    key: string,
    observer: Observer,
  ): Promise<{ snapshot: CreationSnapshot | null; unsubscribe: () => void }> {
    const identity = identityFor(kind, key);
    const unsubscribe = this.observe(identity, observer);
    try {
      await this.admission;
      let record = await this.read(identity);
      if (record?.inFlight && !this.active.has(identity)) {
        await this.publish(identity, record, {
          phase: "failed",
          failedStage: record.inFlight,
          outcomeUnknown: true,
          error: `${kind}_request_outcome_unknown`,
        });
      }
      if (record?.snapshot.phase === "completed") await this.validateCompleted(record.snapshot);
      return { snapshot: record?.snapshot ?? null, unsubscribe };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  private async run(
    identity: string,
    record: Record,
    input: CreationInput,
  ): Promise<CreationSnapshot> {
    try {
      if (input.provision && !record.snapshot.workspace) {
        record.inFlight = "workspace";
        await this.write(identity, record);
        const { workspace, setupSkippedReason } = await input.provision(
          record.snapshot.workspaceId!,
        );
        record.inFlight = null;
        await this.publish(identity, record, {
          phase: "workspace_ready",
          workspace,
          workspaceId: workspace.id,
          setupSkippedReason,
        });
      }
      if (input.hasAgent && input.createAgent && !record.snapshot.agent) {
        record.inFlight = "agent";
        await this.write(identity, record);
        const { agent, initialPromptStarted } = await input.createAgent(
          record.snapshot.agentId!,
          record.snapshot.workspace,
          async (readyAgent) => {
            record.inFlight = input.hasPrompt ? "prompt" : null;
            await this.publish(identity, record, {
              phase: "agent_ready",
              agent: readyAgent,
              workspaceId: readyAgent.workspaceId ?? record.snapshot.workspaceId,
            });
          },
        );
        record.inFlight = null;
        if (initialPromptStarted)
          await this.publish(identity, record, { phase: "prompt_started", agent });
        else record.snapshot = { ...record.snapshot, agent };
      }
      record.inFlight = null;
      await this.publish(identity, record, { phase: "completed" });
    } catch (error) {
      const stage = record.inFlight ?? "agent";
      const resourceId =
        stage === "workspace" ? record.snapshot.workspaceId : record.snapshot.agentId;
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;
      const rejectedBeforeProvision = code === "directory_not_found" || code === "source_required";
      const unknown =
        stage === "prompt" ||
        (stage === "workspace" && !rejectedBeforeProvision) ||
        (resourceId !== null && (await input.exists(stage, resourceId)));
      // A failed provider startup with no registered resource can retry under the same ID.
      // A partially provisioned resource or an attempted prompt needs reconciliation.
      if (!unknown) record.inFlight = null;
      await this.publish(identity, record, {
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
        errorCode: code,
        failedStage: stage,
        outcomeUnknown: unknown,
      });
    }
    return record.snapshot;
  }

  private async claimResources(
    identity: string,
    snapshot: CreationSnapshot,
    input: CreationInput,
  ): Promise<void> {
    if (input.kind === "workspace" && snapshot.workspaceId)
      await this.claim(identity, "workspace", snapshot.workspaceId, input.exists);
    if (snapshot.agentId) await this.claim(identity, "agent", snapshot.agentId, input.exists);
  }

  private async claim(
    identity: string,
    kind: "workspace" | "agent",
    id: string,
    exists: CreationInput["exists"],
  ): Promise<void> {
    const hash = digest([kind, id]);
    const owner = this.load("creation_claim", hash) as string | null;
    if (owner !== null) {
      if (owner !== identity) throw new Error(`${kind}_id_conflict`);
      return;
    }
    if (await exists(kind, id)) throw new Error(`${kind}_id_conflict`);
    this.store("creation_claim", hash, identity);
  }
  private observe(identity: string, observer: Observer): () => void {
    const observers = this.observers.get(identity) ?? new Set<Observer>();
    observers.add(observer);
    this.observers.set(identity, observers);
    return () => {
      observers.delete(observer);
      if (!observers.size) this.observers.delete(identity);
    };
  }
  private notify(observer: Observer, snapshot: CreationSnapshot): void {
    try {
      observer(snapshot);
    } catch (err) {
      this.logger.warn(
        {
          err,
          kind: snapshot.kind,
          idempotencyKey: snapshot.idempotencyKey,
          phase: snapshot.phase,
        },
        "Creation observer failed",
      );
    }
  }
  private async publish(
    identity: string,
    record: Record,
    update: Partial<CreationSnapshot>,
  ): Promise<void> {
    record.snapshot = { ...record.snapshot, ...update, revision: record.snapshot.revision + 1 };
    await this.write(identity, record);
    for (const observer of this.observers.get(identity) ?? [])
      this.notify(observer, record.snapshot);
  }
  private async write(identity: string, record: Record): Promise<void> {
    this.store("creation", identity, record);
  }
  private async read(identity: string): Promise<Record | null> {
    const value = this.load("creation", identity);
    return value === null ? null : RecordSchema.parse(value);
  }
  private store(kind: string, identity: string, value: unknown, at = Date.now()): void {
    // Serialized now: the runner mutates the record after queueing this write.
    this.database.db
      .prepare(
        `INSERT INTO receipts (kind, identity, updated_at, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, identity) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(kind, identity, Math.floor(at), JSON.stringify(value));
  }
  private load(kind: string, identity: string): unknown {
    const row = this.database.db
      .prepare("SELECT json FROM receipts WHERE kind = ? AND identity = ?")
      .get(kind, identity);
    return row ? JSON.parse(String(row.json)) : null;
  }
}
function initialRecord(input: CreationInput, fingerprint: string): Record {
  return {
    fingerprint,
    inFlight: null,
    snapshot: {
      kind: input.kind,
      idempotencyKey: input.key,
      revision: 0,
      phase: "accepted",
      error: null,
      workspaceId: input.workspaceId ?? (input.kind === "workspace" ? generateWorkspaceId() : null),
      agentId: input.hasAgent ? (input.agentId ?? randomUUID()) : null,
    },
  };
}
function identityFor(kind: string, key: string): string {
  return digest([kind, key]);
}
function digest(input: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(input, (_key, value: unknown) => {
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
        return value;
      }),
    )
    .digest("hex");
}
