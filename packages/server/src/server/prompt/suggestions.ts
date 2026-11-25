import { createHash } from "node:crypto";
import {
  ATTACK_RUN_LABEL,
  AUTOMATION_NODE_LABEL,
  AUTOMATION_RUN_LABEL,
  PARENT_AGENT_ID_LABEL,
} from "@pimi/protocol/agent-labels";
import {
  MAX_SAVED_PROMPT_TEXT_LENGTH,
  type PromptSuggestion,
  type PromptSuggestionPosition,
} from "@pimi/protocol/prompt/types";
import type { PimiDatabase } from "../db/pimi-db.js";
import { normalizePrompt } from "./normalize.js";

// ---
// Every constant below is a choice, not a measurement. The derivation says what it is tied to.

const DAY_MS = 24 * 60 * 60_000;

// How far back a chat counts. The same window the project suggestions use for "recently used".
const LOOKBACK_MS = 30 * DAY_MS;

// A phrase typed in fewer chats is a coincidence, not a habit. The same bar the project
// suggestions use to preselect a folder (PRESELECT_MIN_SESSIONS in the app).
const MIN_DISTINCT_CHATS = 3;

// A use loses half its weight every 7 days. 30 / log2(20) is about 6.94 days: a use at the edge
// of the window weighs at most 5% of one today, so old habits fade without a cliff.
const HALF_LIFE_MS = 7 * DAY_MS;

// Three uses today score 3, and three uses spread over the whole window score about 0.2, so this
// floor keeps a habit that has gone quiet out of the list. One recent use is worth exactly 1.
const MIN_SCORE = 1.0;

// "fix it" is a reply, not a prompt worth saving; three words is the shortest request that names
// something.
const MIN_WORDS = 3;

// A suggestion the editor cannot save is no use, so a unit longer than a saved prompt is dropped.
const MAX_CHARS = MAX_SAVED_PROMPT_TEXT_LENGTH;

const DEFAULT_LIMIT = 20;

// Composer chips are U+E000 + slot, 32 slots (MAX_CHIPS in the app's composer/chips/model.ts).
// They are rewritten to `[annotation N]` before a message is stored, so both forms are checked.
const CHIP_CHARACTERS = /[-]/;
const ANNOTATION_MARKER = /\[annotation \d+\]/;

// Labels of chats the user did not prompt: subagents, Attack runs, and agents an automation or a
// flow started. Their prompts repeat by construction.
const NON_USER_LABELS = [
  PARENT_AGENT_ID_LABEL,
  ATTACK_RUN_LABEL,
  AUTOMATION_NODE_LABEL,
  AUTOMATION_RUN_LABEL,
] as const;

export interface SuggestionSources {
  pimiDatabase: PimiDatabase;
  timelineDatabase: PimiDatabase;
  // Commits buffered timeline rows so the read sees the current turn.
  flushTimeline: () => void;
}

export interface ComputeSuggestionsInput {
  sources: SuggestionSources;
  projectId: string;
  position: PromptSuggestionPosition;
  limit?: number;
  nowMs: number;
  // Normalized text of the saved prompts and the keys already dismissed in this project.
  savedPromptTexts: ReadonlySet<string>;
  dismissedKeys: ReadonlySet<string>;
}

interface UnitTally {
  text: string;
  // Latest use per chat, in epoch ms.
  chatLastUsed: Map<string, number>;
}

interface Candidate {
  key: string;
  normalized: string;
  text: string;
  chatIds: ReadonlySet<string>;
  lastUsedMs: number;
  score: number;
}

const AGENT_IDS_SQL = `
  SELECT a.id AS id FROM agents a
  WHERE a.internal = 0 AND a.background = 0 AND a.last_user_message_at >= ?
    AND a.workspace_id IN (
      SELECT id FROM records WHERE kind = 'workspace' AND json_extract(json, '$.projectId') = ?)
    ${NON_USER_LABELS.map(() => "AND json_extract(a.json, ?) IS NULL").join("\n    ")}`;

// Same extraction Recap uses: SQLite parses each row's JSON, only the text crosses into JS.
const USER_MESSAGES_SQL = `
  SELECT r.ts AS ts, json_extract(r.json, '$.text') AS text
  FROM timeline_rows r JOIN timeline_agents a ON a.key = r.agent_key
  WHERE a.agent_id = ? AND r.type = 'user_message'
  ORDER BY r.seq`;

function labelPath(label: string): string {
  return `$.labels."${label}"`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function splitSentences(line: string): string[] {
  return line.split(/(?<=[.!?])\s+/);
}

// The whole message, each line of it, and each sentence of each line: a habit is as often the
// opening sentence of a long message as the whole message.
function unitsOf(text: string): string[] {
  const units = new Set<string>([text.trim()]);
  for (const line of text.split("\n")) {
    units.add(line.trim());
    for (const sentence of splitSentences(line)) units.add(sentence.trim());
  }
  units.delete("");
  return [...units];
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function isCandidateText(normalized: string): boolean {
  if (normalized.startsWith("/")) return false;
  if (CHIP_CHARACTERS.test(normalized) || ANNOTATION_MARKER.test(normalized)) return false;
  if (normalized.length > MAX_CHARS) return false;
  return wordCount(normalized) >= MIN_WORDS;
}

function sameChats(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

function keyOf(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

function tallyChat(input: {
  rows: Array<{ ts: string; text: string }>;
  chatId: string;
  position: PromptSuggestionPosition;
  cutoffMs: number;
  units: Map<string, UnitTally>;
}): void {
  const { rows, chatId, position, cutoffMs, units } = input;
  // "first" counts what opened a chat, so only the chat's first message is read, even when it was
  // sent before the window and the chat is still active inside it.
  const considered = position === "first" ? rows.slice(0, 1) : rows;
  for (const row of considered) {
    const at = Date.parse(row.ts);
    if (!Number.isFinite(at) || at < cutoffMs) continue;
    for (const unit of unitsOf(row.text)) {
      const normalized = normalizePrompt(unit);
      if (!isCandidateText(normalized)) continue;
      const tally = units.get(normalized) ?? { text: unit, chatLastUsed: new Map() };
      const previous = tally.chatLastUsed.get(chatId) ?? 0;
      if (at >= previous) {
        tally.chatLastUsed.set(chatId, at);
        // The most recent wording is what the person would recognize.
        tally.text = unit;
      }
      units.set(normalized, tally);
    }
  }
}

function toCandidate(normalized: string, tally: UnitTally, nowMs: number): Candidate {
  let score = 0;
  let lastUsedMs = 0;
  for (const usedMs of tally.chatLastUsed.values()) {
    score += 0.5 ** ((nowMs - usedMs) / HALF_LIFE_MS);
    lastUsedMs = Math.max(lastUsedMs, usedMs);
  }
  return {
    key: keyOf(normalized),
    normalized,
    text: tally.text,
    chatIds: new Set(tally.chatLastUsed.keys()),
    lastUsedMs,
    score,
  };
}

// A phrase that only ever appears inside a longer one, in the same chats, is the longer one.
function dropContained(candidates: Candidate[]): Candidate[] {
  const longestFirst = [...candidates].sort((a, b) => b.normalized.length - a.normalized.length);
  const kept: Candidate[] = [];
  for (const candidate of longestFirst) {
    const isContained = kept.some(
      (longer) =>
        longer.normalized.includes(candidate.normalized) &&
        sameChats(longer.chatIds, candidate.chatIds),
    );
    if (!isContained) kept.push(candidate);
  }
  return kept;
}

export async function computeSuggestions(
  input: ComputeSuggestionsInput,
): Promise<PromptSuggestion[]> {
  const { sources, nowMs } = input;
  const cutoffMs = nowMs - LOOKBACK_MS;
  sources.flushTimeline();
  const agentIds = sources.pimiDatabase.db
    .prepare(AGENT_IDS_SQL)
    .all(new Date(cutoffMs).toISOString(), input.projectId, ...NON_USER_LABELS.map(labelPath))
    .map((row) => String(row.id));

  const units = new Map<string, UnitTally>();
  for (const chatId of agentIds) {
    const rows = sources.timelineDatabase.db
      .prepare(USER_MESSAGES_SQL)
      .all(chatId)
      .flatMap((row) =>
        typeof row.text === "string" && row.text.trim()
          ? [{ ts: String(row.ts), text: row.text }]
          : [],
      );
    tallyChat({ rows, chatId, position: input.position, cutoffMs, units });
    // One chat's rows are one synchronous read; yield so a busy project never stalls the daemon.
    await yieldToEventLoop();
  }

  const habits = [...units.entries()]
    .map(([normalized, tally]) => toCandidate(normalized, tally, nowMs))
    .filter(
      (candidate) => candidate.chatIds.size >= MIN_DISTINCT_CHATS && candidate.score >= MIN_SCORE,
    );
  // Containment runs before saved and dismissed phrases are removed: a phrase already saved or
  // dismissed still explains the shorter ones inside it, which must not resurface in its place.
  return dropContained(habits)
    .filter(
      (candidate) =>
        !input.savedPromptTexts.has(candidate.normalized) &&
        !input.dismissedKeys.has(candidate.key),
    )
    .sort((a, b) => b.score - a.score || b.lastUsedMs - a.lastUsedMs)
    .slice(0, input.limit ?? DEFAULT_LIMIT)
    .map((candidate) => ({
      key: candidate.key,
      text: candidate.text,
      chats: candidate.chatIds.size,
      lastUsedAt: new Date(candidate.lastUsedMs).toISOString(),
    }));
}
