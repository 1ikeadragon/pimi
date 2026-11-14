import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  LabelAssignmentSchema,
  LabelSchema,
  labelNameKey,
  labelTargetKey,
  normalizeLabelName,
  type Label,
  type LabelAssignment,
  type LabelColor,
  type LabelTarget,
} from "@pimi/protocol/labels";
import type { PimiDatabase } from "../db/pimi-db.js";
import { insertRecord } from "../db/sql-record-store.js";

export type LabelPush =
  | { kind: "label_upsert"; label: Label }
  | { kind: "label_remove"; labelId: string }
  | { kind: "assignment_set"; target: LabelTarget; labelIds: string[] };

export class LabelError extends Error {
  constructor(
    readonly code: "label_not_found" | "label_name_empty" | "label_name_taken" | "target_not_found",
    message: string,
  ) {
    super(message);
    this.name = "LabelError";
  }
}

type Row = Record<string, string | number | bigint | null | Uint8Array>;

const LABEL_KIND = "label";
const ASSIGNMENT_KIND = "label_assignment";

function requireName(raw: string): string {
  const name = normalizeLabelName(raw);
  if (!name) throw new LabelError("label_name_empty", "Label name cannot be empty");
  return name;
}

// One label catalog and one assignment store, both rows of pimi.db `records`: kind `label`
// (id = label id) and kind `label_assignment` (id = labelTargetKey, value = LabelAssignment).
// Rename and recolor write the catalog row only; delete strips every assignment in one
// transaction. Assignment keys contain ":" so this does not go through SqlRecordStore, whose ids
// are restricted to [A-Za-z0-9_-].
export class LabelService {
  private readonly database: PimiDatabase;
  private readonly logger: Logger;
  private readonly targetExists: (target: LabelTarget) => Promise<boolean>;
  private readonly listeners = new Set<(change: LabelPush) => void>();

  constructor(options: {
    database: PimiDatabase;
    logger: Logger;
    targetExists: (target: LabelTarget) => Promise<boolean>;
  }) {
    this.database = options.database;
    this.logger = options.logger.child({ module: "labels" });
    this.targetExists = options.targetExists;
  }

  subscribe(listener: (change: LabelPush) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(changes: readonly LabelPush[]): void {
    for (const change of changes) {
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch (error) {
          this.logger.error({ err: error }, "Label listener failed");
        }
      }
    }
  }

  private readLabels(): Label[] {
    const rows = this.database.db
      .prepare("SELECT id, json FROM records WHERE kind = ? ORDER BY rowid")
      .all(LABEL_KIND) as Row[];
    return rows.flatMap((row) => {
      const parsed = LabelSchema.safeParse(JSON.parse(String(row.json)));
      if (parsed.success) return [parsed.data];
      this.logger.error({ id: String(row.id) }, "Skipping invalid label record");
      return [];
    });
  }

  private readAssignments(): LabelAssignment[] {
    const rows = this.database.db
      .prepare("SELECT id, json FROM records WHERE kind = ? ORDER BY rowid")
      .all(ASSIGNMENT_KIND) as Row[];
    return rows.flatMap((row) => {
      const parsed = LabelAssignmentSchema.safeParse(JSON.parse(String(row.json)));
      if (parsed.success) return [parsed.data];
      this.logger.error({ id: String(row.id) }, "Skipping invalid label assignment record");
      return [];
    });
  }

  list(): { labels: Label[]; assignments: LabelAssignment[] } {
    return { labels: this.readLabels(), assignments: this.readAssignments() };
  }

  getTargetLabelIds(target: LabelTarget): string[] {
    const row = this.database.db
      .prepare("SELECT json FROM records WHERE kind = ? AND id = ?")
      .get(ASSIGNMENT_KIND, labelTargetKey(target)) as Row | undefined;
    if (!row) return [];
    const parsed = LabelAssignmentSchema.safeParse(JSON.parse(String(row.json)));
    return parsed.success ? parsed.data.labelIds : [];
  }

  findByName(name: string): Label | null {
    const key = labelNameKey(name);
    return this.readLabels().find((label) => labelNameKey(label.name) === key) ?? null;
  }

  create(input: { name: string; color: LabelColor }): Label {
    const name = requireName(input.name);
    if (this.findByName(name)) {
      throw new LabelError("label_name_taken", `A label named "${name}" already exists`);
    }
    const label: Label = { id: randomUUID(), name, color: input.color };
    insertRecord(this.database, LABEL_KIND, null, label.id, label);
    this.publish([{ kind: "label_upsert", label }]);
    return label;
  }

  // Returns the existing label when the name exists (its colour is kept).
  ensure(input: { name: string; color: LabelColor }): Label {
    return this.findByName(input.name) ?? this.create(input);
  }

  update(input: { labelId: string; name?: string; color?: LabelColor }): Label {
    const current = this.readLabels().find((label) => label.id === input.labelId);
    if (!current) throw new LabelError("label_not_found", "Label not found");
    const name = input.name === undefined ? current.name : requireName(input.name);
    if (labelNameKey(name) !== labelNameKey(current.name)) {
      if (this.findByName(name)) {
        throw new LabelError("label_name_taken", `A label named "${name}" already exists`);
      }
    }
    const next: Label = { ...current, name, color: input.color ?? current.color };
    if (next.name === current.name && next.color === current.color) return current;
    insertRecord(this.database, LABEL_KIND, null, next.id, next);
    this.publish([{ kind: "label_upsert", label: next }]);
    return next;
  }

  countAffected(labelId: string): number {
    this.requireLabel(labelId);
    return this.readAssignments().filter((entry) => entry.labelIds.includes(labelId)).length;
  }

  delete(labelId: string): number {
    this.requireLabel(labelId);
    const changes: LabelPush[] = [];
    this.database.transaction(() => {
      for (const entry of this.readAssignments()) {
        if (!entry.labelIds.includes(labelId)) continue;
        const labelIds = entry.labelIds.filter((id) => id !== labelId);
        this.writeAssignment(entry.target, labelIds);
        changes.push({ kind: "assignment_set", target: entry.target, labelIds });
      }
      this.database.db
        .prepare("DELETE FROM records WHERE kind = ? AND id = ?")
        .run(LABEL_KIND, labelId);
    });
    this.publish([{ kind: "label_remove", labelId }, ...changes]);
    return changes.length;
  }

  async setAssignment(input: {
    target: LabelTarget;
    labelId: string;
    assigned: boolean;
  }): Promise<string[]> {
    this.requireLabel(input.labelId);
    if (input.assigned && !(await this.targetExists(input.target))) {
      throw new LabelError("target_not_found", "Label target not found");
    }
    const current = this.getTargetLabelIds(input.target);
    const has = current.includes(input.labelId);
    if (has === input.assigned) return current;
    const labelIds = input.assigned
      ? [...current, input.labelId]
      : current.filter((id) => id !== input.labelId);
    this.writeAssignment(input.target, labelIds);
    this.publish([{ kind: "assignment_set", target: input.target, labelIds }]);
    return labelIds;
  }

  // Replaces a target's whole label set. Unknown ids are an error.
  async setTargetLabels(target: LabelTarget, labelIds: readonly string[]): Promise<string[]> {
    const catalog = new Set(this.readLabels().map((label) => label.id));
    const unique = [...new Set(labelIds)];
    for (const id of unique) {
      if (!catalog.has(id)) throw new LabelError("label_not_found", "Label not found");
    }
    if (unique.length > 0 && !(await this.targetExists(target))) {
      throw new LabelError("target_not_found", "Label target not found");
    }
    const current = this.getTargetLabelIds(target);
    if (current.length === unique.length && current.every((id) => unique.includes(id))) {
      return current;
    }
    this.writeAssignment(target, unique);
    this.publish([{ kind: "assignment_set", target, labelIds: unique }]);
    return unique;
  }

  // Drops a deleted target's assignment. `agent` also drops the subagents under that chat.
  removeTarget(target: LabelTarget): void {
    const doomed = this.readAssignments().filter((entry) => {
      if (labelTargetKey(entry.target) === labelTargetKey(target)) return true;
      return (
        target.kind === "agent" &&
        entry.target.kind === "subagent" &&
        entry.target.parentAgentId === target.agentId
      );
    });
    for (const entry of doomed) {
      this.writeAssignment(entry.target, []);
    }
    this.publish(
      doomed.map((entry) => ({
        kind: "assignment_set" as const,
        target: entry.target,
        labelIds: [],
      })),
    );
  }

  private requireLabel(labelId: string): Label {
    const label = this.readLabels().find((entry) => entry.id === labelId);
    if (!label) throw new LabelError("label_not_found", "Label not found");
    return label;
  }

  // An empty set removes the row.
  private writeAssignment(target: LabelTarget, labelIds: readonly string[]): void {
    const key = labelTargetKey(target);
    if (labelIds.length === 0) {
      this.database.db
        .prepare("DELETE FROM records WHERE kind = ? AND id = ?")
        .run(ASSIGNMENT_KIND, key);
      return;
    }
    insertRecord(this.database, ASSIGNMENT_KIND, null, key, {
      target,
      labelIds: [...labelIds],
    } satisfies LabelAssignment);
  }
}
