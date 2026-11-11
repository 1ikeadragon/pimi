import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  LspProcess,
  LspUnavailableError,
  pathToUri,
  uriToPath,
  type LspLocation,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from "./lsp-client.js";
import type { LspLanguage, LspLaunchSpec } from "./lsp-servers.js";
import type {
  CodeNavigationEdit,
  CodeNavigationLocation,
  CodeNavigationQuery,
  ProviderResult,
} from "./types.js";

// One server process per workspace and language, started on first use, stopped after sitting idle,
// and capped so a user who opens many workspaces cannot accumulate language servers.
const SERVER_IDLE_MS = 5 * 60_000;
const MAX_SERVERS = 6;
const NAVIGATION_TIMEOUT_MS = 2_500;
// The first answer of a fresh server waits for it to load the project.
const COLD_START_TIMEOUT_MS = 12_000;
const RENAME_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 500;
const MAX_EDITS = 5_000;
const MAX_PREVIEW_CHARS = 200;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

interface Entry {
  process: LspProcess;
  timer: NodeJS.Timeout;
  usedAt: number;
}

const entries = new Map<string, Entry>();

function stopEntry(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entries.delete(key);
  entry.process.stop();
}

function serverFor(
  workspaceId: string,
  cwd: string,
  language: LspLanguage,
  launch: LspLaunchSpec,
): LspProcess {
  const key = `${workspaceId}\0${language.id}\0${launch.executable}\0${launch.args.join(" ")}`;
  // A changed server setting starts a fresh process for the language.
  for (const other of entries.keys()) {
    if (other.startsWith(`${workspaceId}\0${language.id}\0`) && other !== key) stopEntry(other);
  }
  const existing = entries.get(key);
  if (existing?.process.alive) {
    touch(key, existing);
    return existing.process;
  }
  while (entries.size >= MAX_SERVERS) {
    const oldest = [...entries.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
    if (!oldest) break;
    stopEntry(oldest[0]);
  }
  const process = new LspProcess(cwd, launch, () => {
    if (entries.get(key)?.process === process) {
      clearTimeout(entries.get(key)?.timer);
      entries.delete(key);
    }
  });
  const entry: Entry = { process, timer: setTimeout(() => undefined, 0), usedAt: Date.now() };
  entries.set(key, entry);
  touch(key, entry);
  return process;
}

function touch(key: string, entry: Entry): void {
  clearTimeout(entry.timer);
  entry.usedAt = Date.now();
  entry.timer = setTimeout(() => stopEntry(key), SERVER_IDLE_MS);
  entry.timer.unref();
}

export function closeLspForWorkspace(workspaceId: string): void {
  for (const key of entries.keys()) {
    if (key.startsWith(`${workspaceId}\0`)) stopEntry(key);
  }
}

export function closeAllLsp(): void {
  for (const key of entries.keys()) stopEntry(key);
}

function displayPath(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? file : rel.split(sep).join("/");
}

function insideWorkspace(cwd: string, file: string): string | null {
  const rel = relative(cwd, file);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
}

interface LocationLike {
  uri?: string;
  range?: LspLocation["range"];
  targetUri?: string;
  targetSelectionRange?: LspLocation["range"];
}

function normalizeLocations(result: unknown): LspLocation[] {
  let list: unknown[] = [];
  if (Array.isArray(result)) list = result;
  else if (result) list = [result];
  const locations: LspLocation[] = [];
  for (const item of list as LocationLike[]) {
    if (item.targetUri && item.targetSelectionRange) {
      locations.push({ uri: item.targetUri, range: item.targetSelectionRange });
    } else if (item.uri && item.range) {
      locations.push({ uri: item.uri, range: item.range });
    }
  }
  return locations;
}

const lineCache = new Map<string, string[] | null>();

async function previewLine(file: string, line: number): Promise<string> {
  let lines = lineCache.get(file);
  if (lines === undefined) {
    lines = await readFile(file, "utf8")
      .then((text) => text.split(/\r\n|\n|\r/))
      .catch(() => null);
    lineCache.set(file, lines);
  }
  return (lines?.[line] ?? "").trim().slice(0, MAX_PREVIEW_CHARS);
}

async function toResults(
  cwd: string,
  locations: LspLocation[],
  definitionKeys: Set<string>,
): Promise<{ results: CodeNavigationLocation[]; truncated: boolean }> {
  const results: CodeNavigationLocation[] = [];
  for (const location of locations.slice(0, MAX_RESULTS)) {
    const file = uriToPath(location.uri);
    const { line, character } = location.range.start;
    results.push({
      path: displayPath(cwd, file),
      line: line + 1,
      column: character + 1,
      preview: await previewLine(file, line),
      role: definitionKeys.has(`${location.uri}\0${line}\0${character}`)
        ? "definition"
        : "reference",
    });
  }
  return { results, truncated: locations.length > MAX_RESULTS };
}

function toEdits(cwd: string, edit: LspWorkspaceEdit | null): CodeNavigationEdit[] {
  const byUri = new Map<string, LspTextEdit[]>();
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) byUri.set(uri, edits);
  for (const change of edit?.documentChanges ?? []) {
    if (!("textDocument" in change)) {
      throw new Error("This rename creates, renames or deletes files, which Pimi does not apply.");
    }
    byUri.set(change.textDocument.uri, [
      ...(byUri.get(change.textDocument.uri) ?? []),
      ...change.edits,
    ]);
  }
  const edits: CodeNavigationEdit[] = [];
  for (const [uri, textEdits] of byUri) {
    const path = insideWorkspace(cwd, uriToPath(uri));
    if (!path) throw new Error("Renaming would change files outside this workspace.");
    for (const textEdit of textEdits) {
      edits.push({
        path,
        line: textEdit.range.start.line + 1,
        column: textEdit.range.start.character + 1,
        endLine: textEdit.range.end.line + 1,
        endColumn: textEdit.range.end.character + 1,
        newText: textEdit.newText,
      });
    }
  }
  if (edits.length > MAX_EDITS)
    throw new Error(`Renaming would make ${edits.length} edits; too many.`);
  return edits;
}

/** Answers definition, references and rename from a language server. Throws when it cannot. */
export async function queryLsp(
  query: CodeNavigationQuery,
  language: LspLanguage,
  launch: LspLaunchSpec,
): Promise<ProviderResult> {
  const file = resolve(query.cwd, query.path);
  if (!insideWorkspace(query.cwd, file)) {
    throw new LspUnavailableError("The file is outside this workspace.");
  }
  lineCache.clear();
  const text = query.content ?? (await readFile(file, "utf8"));
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) {
    throw new LspUnavailableError("The file is too large for the language server.");
  }
  const server = serverFor(query.workspaceId, query.cwd, language, launch);
  const timeout = server.warm ? NAVIGATION_TIMEOUT_MS : COLD_START_TIMEOUT_MS;
  const uri = await syncWithin(server, file, language.languageId, text, timeout);
  const position = { line: query.line - 1, character: query.column - 1 };
  const textDocument = { uri };
  const base = { provider: "lsp", serverName: launch.name, note: null } as const;

  if (query.kind === "rename") {
    if (server.supportsPrepareRename()) {
      const prepared = await server.request(
        "textDocument/prepareRename",
        { textDocument, position },
        RENAME_TIMEOUT_MS,
      );
      if (prepared === null) throw new Error("This symbol cannot be renamed.");
    }
    const edit = (await server.request(
      "textDocument/rename",
      { textDocument, position, newName: query.newName ?? query.symbol },
      RENAME_TIMEOUT_MS,
    )) as LspWorkspaceEdit | null;
    const edits = toEdits(query.cwd, edit);
    if (edits.length === 0) {
      // Intelephense answers a rename without a licence key with an empty edit.
      const licence =
        launch.name === "Intelephense" ? " Intelephense may need a licence key to rename." : "";
      throw new Error(`${launch.name} returned no rename edits.${licence}`);
    }
    return { ...base, results: [], truncated: false, edits };
  }

  const definitions = normalizeLocations(
    await server.request("textDocument/definition", { textDocument, position }, timeout),
  );
  if (query.kind === "definition") {
    const located = await toResults(query.cwd, definitions, new Set(definitions.map(keyOf)));
    return { ...base, ...located, edits: [] };
  }
  const references = normalizeLocations(
    await server.request(
      "textDocument/references",
      { textDocument, position, context: { includeDeclaration: true } },
      timeout,
    ),
  );
  const located = await toResults(query.cwd, references, new Set(definitions.map(keyOf)));
  return { ...base, ...located, edits: [] };
}

function keyOf(location: LspLocation): string {
  return `${location.uri}\0${location.range.start.line}\0${location.range.start.character}`;
}

async function syncWithin(
  server: LspProcess,
  file: string,
  languageId: string,
  text: string,
  timeout: number,
): Promise<string> {
  const sync = server.syncDocument(file, languageId, text);
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new LspUnavailableError(`The language server did not start within ${timeout} ms.`)),
      timeout,
    );
  });
  try {
    return await Promise.race([sync, limit]);
  } finally {
    clearTimeout(timer);
  }
}

export { pathToUri };
