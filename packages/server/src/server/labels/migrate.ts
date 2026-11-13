import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import { z } from "zod";
import {
  LABEL_COLORS,
  LabelColorSchema,
  labelNameKey,
  normalizeLabelName,
} from "@pimi/protocol/labels";
import { PARENT_AGENT_ID_LABEL } from "@pimi/protocol/agent-labels";
import { randomUUID } from "node:crypto";
import { runJsonImportOnce, type PimiDatabase } from "../db/pimi-db.js";
import { insertRecord } from "../db/sql-record-store.js";

const LegacyCatalogSchema = z.array(z.object({ name: z.string(), color: z.string() }));
type Row = Record<string, string | number | bigint | null | Uint8Array>;

const FALLBACK_COLOR = LABEL_COLORS[0];

async function readLegacyCatalog(file: string, logger: Logger) {
  try {
    return LegacyCatalogSchema.parse(JSON.parse(await readFile(file, "utf-8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err: error, file }, "Could not read the legacy workspace label catalog");
    }
    return [];
  }
}

// COMPAT(workspace-labels.json): builds before the shared label catalog kept the catalog in
// projects/workspace-labels.json and label names on each workspace record. Run once after the
// workspace registry has loaded: catalog -> `label` rows; each workspace's names -> an assignment
// on its oldest non-archived root chat; `labels` stripped from workspace rows. A workspace with
// no root chat loses its labels (logged). The JSON files are renamed to `.migrated`.
export async function migrateWorkspaceLabels(options: {
  database: PimiDatabase;
  pimiHome: string;
  logger: Logger;
}): Promise<void> {
  const { database, logger } = options;
  const catalogFile = join(options.pimiHome, "projects", "workspace-labels.json");
  const journalFile = join(options.pimiHome, "projects", "workspace-labels.transaction.json");
  const catalog = await readLegacyCatalog(catalogFile, logger);

  await runJsonImportOnce(
    database,
    { name: "workspace_labels", legacyPaths: [catalogFile, journalFile], logger },
    () => {
      const idsByName = new Map<string, string>();
      const ensure = (rawName: string, rawColor: string | undefined): string => {
        const name = normalizeLabelName(rawName);
        const key = labelNameKey(name);
        const existing = idsByName.get(key);
        if (existing) return existing;
        const color = LabelColorSchema.safeParse(rawColor);
        if (!color.success) {
          logger.warn({ name, color: rawColor }, "Label has no known colour; using the default");
        }
        const id = randomUUID();
        insertRecord(database, "label", null, id, {
          id,
          name,
          color: color.success ? color.data : FALLBACK_COLOR,
        });
        idsByName.set(key, id);
        return id;
      };
      for (const entry of catalog) ensure(entry.name, entry.color);

      const agents = (
        database.db
          .prepare("SELECT id, workspace_id, json FROM agents WHERE archived_at IS NULL")
          .all() as Row[]
      )
        .map((row) => {
          const json = JSON.parse(String(row.json)) as {
            createdAt?: string;
            labels?: Record<string, string>;
            internal?: boolean;
            background?: boolean;
          };
          return { id: String(row.id), workspaceId: row.workspace_id as string | null, json };
        })
        .filter(
          ({ json, workspaceId }) =>
            workspaceId &&
            !json.internal &&
            !json.background &&
            !Object.hasOwn(json.labels ?? {}, PARENT_AGENT_ID_LABEL),
        )
        .sort((a, b) => (a.json.createdAt ?? "").localeCompare(b.json.createdAt ?? ""));

      const workspaces = database.db
        .prepare("SELECT id, json FROM records WHERE kind = 'workspace'")
        .all() as Row[];
      for (const row of workspaces) {
        const record = JSON.parse(String(row.json)) as { labels?: string[] };
        if (!Array.isArray(record.labels)) continue;
        const names = record.labels;
        const { labels: _labels, ...rest } = record;
        database.db
          .prepare("UPDATE records SET json = ? WHERE kind = 'workspace' AND id = ?")
          .run(JSON.stringify(rest), String(row.id));
        if (names.length === 0) continue;
        const root = agents.find((agent) => agent.workspaceId === String(row.id));
        if (!root) {
          logger.warn(
            { workspaceId: String(row.id), labels: names },
            "Workspace labels dropped: the workspace has no root chat",
          );
          continue;
        }
        const labelIds = [...new Set(names.map((name) => ensure(name, undefined)))];
        const target = { kind: "agent" as const, agentId: root.id };
        insertRecord(database, "label_assignment", null, `agent:${root.id}`, { target, labelIds });
      }
    },
  );
}
