import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createOccurrenceClassifier, type DeclarationTier } from "@pimi/highlight";
import { createRunGitCommand } from "../../utils/run-git-command.js";
import type { CodeNavigationLocation, CodeNavigationProvider } from "./types.js";

const runGit = createRunGitCommand("code-navigation");

const MAX_RESULTS = 500;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
// Parsing is the expensive step. Past these limits a hit is kept unclassified rather than dropped.
const MAX_CLASSIFIED_FILE_BYTES = 1024 * 1024;
const CLASSIFY_BUDGET_MS = 400;
const MAX_PREVIEW_CHARS = 200;

// Files whose text names a symbol without referring to it: prose, data, lockfiles.
const NON_CODE_EXTENSIONS = new Set([
  "md",
  "mdx",
  "markdown",
  "txt",
  "lock",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "xml",
  "svg",
  "plist",
  "diff",
  "patch",
  "ini",
  "cfg",
  "conf",
  "properties",
  "env",
  "csv",
  "map",
]);

interface RawHit {
  path: string;
  line: number;
  text: string;
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_$]/u.test(character);
}

/** Every whole-word occurrence of `symbol` in `line`, as 0-based columns. */
function wordColumns(line: string, symbol: string): number[] {
  const columns: number[] = [];
  for (let from = line.indexOf(symbol); from !== -1; from = line.indexOf(symbol, from + 1)) {
    if (!isWordCharacter(line[from - 1]) && !isWordCharacter(line[from + symbol.length])) {
      columns.push(from);
    }
  }
  return columns;
}

/** `git grep` passes the symbol as one argument after `-e`, so it is never read as a flag or a shell word. */
async function grepSymbol(cwd: string, symbol: string, signal: AbortSignal) {
  const result = await runGit(
    ["grep", "-n", "-w", "-F", "-z", "-I", "--untracked", "--no-color", "-e", symbol, "--", "."],
    {
      cwd,
      signal,
      timeout: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      acceptExitCodes: [0, 1],
    },
  );
  const hits: RawHit[] = [];
  for (const record of result.stdout.split("\n")) {
    const first = record.indexOf("\0");
    const second = first === -1 ? -1 : record.indexOf("\0", first + 1);
    if (second === -1) continue;
    const path = record.slice(0, first);
    if (NON_CODE_EXTENSIONS.has(extensionOf(path))) continue;
    hits.push({
      path,
      line: Number(record.slice(first + 1, second)),
      text: record.slice(second + 1),
    });
  }
  return { hits, truncated: result.truncated };
}

interface Occurrence extends CodeNavigationLocation {
  tier: DeclarationTier | null;
}

function orderFiles(paths: Iterable<string>, current: string): string[] {
  // The file being edited answers first, so its own uses lead the list.
  return [...paths].sort((a, b) => {
    if (a === b) return 0;
    if (a === current) return -1;
    if (b === current) return 1;
    return a.localeCompare(b);
  });
}

function groupByFile(hits: RawHit[]): Map<string, RawHit[]> {
  const byFile = new Map<string, RawHit[]>();
  for (const hit of hits) {
    const list = byFile.get(hit.path);
    if (list) list.push(hit);
    else byFile.set(hit.path, [hit]);
  }
  return byFile;
}

/** Whole-word occurrences in one file's grep hits, with strings and comments dropped. */
function occurrencesInFile(
  path: string,
  fileHits: RawHit[],
  symbol: string,
  classifier: FileClassifier | null,
): Occurrence[] {
  const found: Occurrence[] = [];
  for (const hit of fileHits) {
    const lineStart = classifier?.lineStarts[hit.line - 1];
    for (const column of wordColumns(hit.text, symbol)) {
      let tier: DeclarationTier | null = null;
      if (classifier && lineStart !== undefined) {
        const offset = lineStart + column;
        if (classifier.value.isIgnored(offset)) continue;
        tier = classifier.value.declarationTier(offset);
      }
      found.push({
        path,
        line: hit.line,
        column: column + 1,
        preview: hit.text.trim().slice(0, MAX_PREVIEW_CHARS),
        role: "reference",
        tier,
      });
    }
  }
  return found;
}

/**
 * Name matching cannot tell scopes apart, so the best declaration tier present is "the
 * definition": real declarations beat import bindings, which beat parameters and object keys.
 */
function assignRoles(occurrences: Occurrence[]): CodeNavigationLocation[] {
  let bestTier = 3;
  for (const { tier } of occurrences) {
    if (tier !== null && tier < bestTier) bestTier = tier;
  }
  return occurrences.map((occurrence) => {
    const { tier, ...location } = occurrence;
    return { ...location, role: tier !== null && tier === bestTier ? "definition" : "reference" };
  });
}

export const nameProvider: CodeNavigationProvider = async (query, signal) => {
  if (query.kind === "rename") {
    throw new Error("Rename needs a language server; only name matching is available here.");
  }
  const { hits, truncated: gitTruncated } = await grepSymbol(query.cwd, query.symbol, signal);
  const byFile = groupByFile(hits);

  const deadline = Date.now() + CLASSIFY_BUDGET_MS;
  const occurrences: Occurrence[] = [];
  let truncated = gitTruncated;
  for (const path of orderFiles(byFile.keys(), query.path)) {
    signal.throwIfAborted();
    if (occurrences.length >= MAX_RESULTS) {
      truncated = true;
      break;
    }
    const classifier = await classifierFor(query.cwd, path, deadline);
    occurrences.push(...occurrencesInFile(path, byFile.get(path) ?? [], query.symbol, classifier));
  }
  if (occurrences.length > MAX_RESULTS) {
    occurrences.length = MAX_RESULTS;
    truncated = true;
  }

  const results = assignRoles(occurrences);
  if (query.kind === "definition") {
    const definitions = results.filter((result) => result.role === "definition");
    // With no recognised declaration, show every occurrence so a language without declaration
    // nodes still gets a list to choose from.
    return {
      provider: "name",
      serverName: null,
      note: null,
      results: definitions.length > 0 ? definitions : results,
      truncated,
      edits: [],
    };
  }
  return { provider: "name", serverName: null, note: null, results, truncated, edits: [] };
};

interface FileClassifier {
  /** Offset of the first character of each line. */
  lineStarts: number[];
  value: NonNullable<ReturnType<typeof createOccurrenceClassifier>>;
}

async function classifierFor(
  cwd: string,
  path: string,
  deadline: number,
): Promise<FileClassifier | null> {
  if (Date.now() > deadline) return null;
  try {
    const absolute = join(cwd, path);
    const info = await stat(absolute);
    if (info.size > MAX_CLASSIFIED_FILE_BYTES) return null;
    const code = await readFile(absolute, "utf8");
    const value = createOccurrenceClassifier(code, path);
    if (!value) return null;
    const lineStarts = [0];
    for (let index = code.indexOf("\n"); index !== -1; index = code.indexOf("\n", index + 1)) {
      lineStarts.push(index + 1);
    }
    return { lineStarts, value };
  } catch {
    return null;
  }
}
