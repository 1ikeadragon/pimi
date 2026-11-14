import { chmod, mkdir, open, readdir, readFile, rm, truncate } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { projectTimelineRows, type TimelineProjectionEntry } from "../timeline-projection.js";
import { PRIVATE_DIRECTORY_MODE, writePrivateFileAtomic } from "../../private-files.js";
import type { HandoffHistorySource } from "./history.js";

const PART_BYTES = 5 * 1024 * 1024;
const MANIFEST_FILE = "manifest.json";
const INDEX_FILE = "index.md";
const PART_PREFIX = "part-";
const INLINE_MAX = 160;
const TURN_LINE_MAX = 120;

interface TranscriptManifest {
  epoch: string;
  throughSeq: number;
  parts: Array<{ file: string; fromSeq: number; bytes: number }>;
  turns: Array<{ seq: number; part: string; text: string }>;
  switches: Array<{ seq: number; from: string; to: string; reason?: string }>;
}

export interface TranscriptMeta {
  agentId: string;
  title: string | null;
  cwd: string;
  /** The provider and model the chat runs on now. */
  endpoint: string;
}

interface InFlight {
  promise: Promise<void>;
  again: boolean;
}

function partFile(index: number): string {
  return `${PART_PREFIX}${String(index).padStart(4, "0")}.md`;
}

function fenceFor(text: string): string {
  let longest = 2;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(longest + 1);
}

function leaf(label: string, value: string): string {
  if (!value.includes("\n") && value.length <= INLINE_MAX) return `${label}: ${value}`;
  const fence = fenceFor(value);
  return `${label}:\n${fence}\n${value}\n${fence}`;
}

/** Walks a tool call's detail so every string keeps its real newlines for line-oriented readers. */
function flatten(value: unknown, label: string, out: string[]): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    out.push(leaf(label, value));
  } else if (value === null || typeof value !== "object") {
    out.push(`${label}: ${String(value)}`);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(entry, `${label}[${index}]`, out));
  } else {
    for (const [key, entry] of Object.entries(value)) flatten(entry, `${label}.${key}`, out);
  }
}

function describeItem(item: AgentTimelineItem): { kind: string; body: string } {
  switch (item.type) {
    case "user_message":
      return { kind: "user", body: item.text };
    case "assistant_message":
      return { kind: "assistant", body: item.text };
    case "reasoning":
      return { kind: "reasoning", body: item.text };
    case "tool_call": {
      const lines = [`callId: ${item.callId}`];
      flatten(item.detail, "detail", lines);
      if (item.error) flatten(item.error, "error", lines);
      if (item.agentMessage) flatten(item.agentMessage, "agentMessage", lines);
      return { kind: `tool_call ${item.name} (${item.status})`, body: lines.join("\n") };
    }
    case "todo":
      return {
        kind: "todo",
        body: item.items
          .map((entry) => `- [${entry.completed ? "x" : " "}] ${entry.text}`)
          .join("\n"),
      };
    case "error":
      return { kind: "error", body: item.message };
    case "notification":
      return {
        kind: item.providerSwitch ? "provider switch" : `notification (${item.level})`,
        body: item.message,
      };
    case "compaction":
      return { kind: `compaction (${item.status})`, body: "" };
    case "plugin":
      return { kind: `plugin ${item.pluginId}/${item.kind}`, body: "" };
    default:
      return { kind: item.type, body: "" };
  }
}

function renderEntry(entry: TimelineProjectionEntry): string {
  const { kind, body } = describeItem(entry.item);
  const range =
    entry.seqEnd === entry.seqStart ? `${entry.seqStart}` : `${entry.seqStart}-${entry.seqEnd}`;
  return `## seq ${range} · ${entry.timestamp} · ${kind}\n\n${body}\n\n`;
}

function endpointLabel(endpoint: {
  provider: string;
  providerLabel?: string;
  model?: string | null;
  modelLabel?: string;
}): string {
  const provider = endpoint.providerLabel ?? endpoint.provider;
  const model = endpoint.modelLabel ?? endpoint.model;
  return model ? `${provider} · ${model}` : provider;
}

function renderIndex(manifest: TranscriptManifest, meta: TranscriptMeta): string {
  const lines = [
    `# Chat transcript: ${meta.title ?? "(untitled)"}`,
    "",
    `Agent: ${meta.agentId}`,
    `Directory: ${meta.cwd}`,
    `Now running on: ${meta.endpoint}`,
    "",
    "Each part-NNNN.md holds timeline entries in order, one `## seq N · time · kind` heading each,",
    "with tool input and stored output in fenced blocks. Search with grep -n; read by line range.",
    "",
    "## Parts",
    ...manifest.parts.map((part) => `- ${part.file}: from seq ${part.fromSeq}`),
    "",
    "## Provider switches",
    ...(manifest.switches.length > 0
      ? manifest.switches.map(
          (entry) =>
            `- seq ${entry.seq}: ${entry.from} -> ${entry.to}${entry.reason ? ` (${entry.reason})` : ""}`,
        )
      : ["- none"]),
    "",
    "## User turns",
    ...manifest.turns.map((turn) => `- seq ${turn.seq} · ${turn.part} · ${turn.text}`),
    "",
    `Status: complete through seq ${manifest.throughSeq}`,
    "",
  ];
  return lines.join("\n");
}

function recordEntry(
  manifest: TranscriptManifest,
  entry: TimelineProjectionEntry,
  partName: string,
): void {
  const { item } = entry;
  if (item.type === "user_message") {
    const first = item.text.trim().split("\n")[0] ?? "";
    manifest.turns.push({
      seq: entry.seqStart,
      part: partName,
      text: first.length > TURN_LINE_MAX ? `${first.slice(0, TURN_LINE_MAX)}...` : first,
    });
  } else if (item.type === "notification" && item.providerSwitch) {
    const marker = item.providerSwitch;
    manifest.switches.push({
      seq: entry.seqStart,
      from: endpointLabel(marker.from),
      to: endpointLabel(marker.to),
      ...(marker.reason ? { reason: marker.reason } : {}),
    });
  }
}

/**
 * Full chat transcripts as Markdown under `$PIMI_HOME/agent-transcripts/<agentId>/`, written for
 * a provider that took a chat over and needs more than the summary it was handed. Files are
 * append-only parts of about 5 MB plus an index; a sync continues from the last stored seq.
 * Regenerable from the stored timeline, so it is dropped with the chat and on archive.
 */
export class TranscriptStore {
  private readonly inFlight = new Map<string, InFlight>();
  /** Agents that have a transcript directory; launch configs ask this synchronously. */
  private readonly known = new Set<string>();

  constructor(
    readonly root: string,
    private readonly logger: Logger,
  ) {}

  directory(agentId: string): string {
    return path.join(this.root, agentId);
  }

  /** Created before the session that will read it is opened, so launch configs can name it. */
  async ensureDirectory(agentId: string): Promise<string> {
    const directory = this.directory(agentId);
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (process.platform !== "win32") {
      await chmod(this.root, PRIVATE_DIRECTORY_MODE).catch(() => undefined);
      await chmod(directory, PRIVATE_DIRECTORY_MODE).catch(() => undefined);
    }
    this.known.add(agentId);
    return directory;
  }

  has(agentId: string): boolean {
    return this.known.has(agentId);
  }

  /** Bring the transcript up to date. Calls made while one runs share it and run it once more. */
  sync(source: HandoffHistorySource, meta: TranscriptMeta): Promise<void> {
    const running = this.inFlight.get(meta.agentId);
    if (running) {
      running.again = true;
      return running.promise;
    }
    const state: InFlight = { again: false, promise: Promise.resolve() };
    state.promise = (async () => {
      try {
        do {
          state.again = false;
          await this.run(source, meta);
        } while (state.again);
      } finally {
        this.inFlight.delete(meta.agentId);
      }
    })();
    this.inFlight.set(meta.agentId, state);
    return state.promise;
  }

  async remove(agentId: string): Promise<void> {
    await this.inFlight.get(agentId)?.promise.catch(() => undefined);
    this.known.delete(agentId);
    await rm(this.directory(agentId), { recursive: true, force: true });
  }

  /** Removes the transcripts of agents that no longer exist and remembers the rest. */
  async sweepOrphans(knownAgentIds: ReadonlySet<string>): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (knownAgentIds.has(name)) {
        this.known.add(name);
        continue;
      }
      await rm(path.join(this.root, name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  private async readManifest(directory: string): Promise<TranscriptManifest | null> {
    try {
      return JSON.parse(
        await readFile(path.join(directory, MANIFEST_FILE), "utf8"),
      ) as TranscriptManifest;
    } catch {
      return null;
    }
  }

  /** The manifest to continue from, or a fresh one when the stored parts do not match the rows. */
  private async openManifest(
    source: HandoffHistorySource,
    meta: TranscriptMeta,
  ): Promise<TranscriptManifest> {
    const directory = await this.ensureDirectory(meta.agentId);
    const epoch = source.epoch();
    const manifest = await this.readManifest(directory);
    if (manifest && manifest.epoch === epoch && manifest.throughSeq <= (source.maxSeq() ?? 0)) {
      const last = manifest.parts.at(-1);
      // A write cut short by a crash leaves bytes the manifest never counted.
      if (last) await truncate(path.join(directory, last.file), last.bytes).catch(() => undefined);
      return manifest;
    }
    // A rewind or a rebuilt timeline: the stored rows are not the ones the parts describe.
    await rm(directory, { recursive: true, force: true });
    await this.ensureDirectory(meta.agentId);
    return { epoch, throughSeq: 0, parts: [], turns: [], switches: [] };
  }

  private async run(source: HandoffHistorySource, meta: TranscriptMeta): Promise<void> {
    const directory = await this.ensureDirectory(meta.agentId);
    const manifest = await this.openManifest(source, meta);
    for await (const rows of source.blocks(manifest.throughSeq)) {
      if (source.epoch() !== manifest.epoch) return;
      const entries = projectTimelineRows({ rows, mode: "projected" });
      let part = manifest.parts.at(-1);
      if (!part || part.bytes >= PART_BYTES) {
        part = {
          file: partFile(manifest.parts.length + 1),
          fromSeq: entries[0]?.seqStart ?? manifest.throughSeq + 1,
          bytes: 0,
        };
        manifest.parts.push(part);
      }
      let text = "";
      for (const entry of entries) {
        text += renderEntry(entry);
        recordEntry(manifest, entry, part.file);
      }
      const handle = await open(path.join(directory, part.file), "a", 0o600);
      try {
        await handle.write(text);
      } finally {
        await handle.close();
      }
      part.bytes += Buffer.byteLength(text);
      manifest.throughSeq = rows.at(-1)?.seq ?? manifest.throughSeq;
      await writePrivateFileAtomic(path.join(directory, MANIFEST_FILE), JSON.stringify(manifest));
    }
    await writePrivateFileAtomic(path.join(directory, INDEX_FILE), renderIndex(manifest, meta));
    this.logger.debug(
      { agentId: meta.agentId, throughSeq: manifest.throughSeq, parts: manifest.parts.length },
      "agent.handoff.transcript_synced",
    );
  }
}
