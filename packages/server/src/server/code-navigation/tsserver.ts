import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { buildSelfNodeCommand } from "../paseo-env.js";
import type {
  CodeNavigationEdit,
  CodeNavigationLocation,
  CodeNavigationQuery,
  ProviderResult,
} from "./types.js";
import { NETWORK_PURPOSE } from "@pimi/protocol/network-activity";
import { trackChildProcess } from "../../utils/process-launch.js";

// tsserver's stdio protocol, spoken directly: a JSON request per line in, `Content-Length` framed
// JSON out. Responses carry `request_seq`; everything else (events) is ignored.

const SERVER_IDLE_MS = 10 * 60_000;
const NAVIGATION_TIMEOUT_MS = 2_000;
// Renaming waits for a cold project to load instead of giving up, since there is no fallback.
const RENAME_TIMEOUT_MS = 20_000;
const MAX_RESULTS = 500;
const MAX_EDITS = 5_000;
const MAX_PREVIEW_CHARS = 200;
const STOP_GRACE_MS = 2_000;
// Each tsserver holds a whole project in memory, so only the most recently used few stay alive.
const MAX_SERVERS = 3;

const TS_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);

export function isTypeScriptFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  return TS_EXTENSIONS.has(name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");
}

export class TsServerUnavailableError extends Error {}

interface TsPosition {
  line: number;
  offset: number;
}
interface TsSpan {
  start: TsPosition;
  end: TsPosition;
  prefixText?: string;
  suffixText?: string;
}
interface TsResponse {
  type: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: unknown;
}

/** Resolves the TypeScript that ships with the daemon; a workspace copy is never run. */
export function resolveTsServerPath(cwd: string): string {
  // Only the bundled TypeScript: a workspace copy is code from the repo, run on right-click.
  void cwd;
  for (const base of [import.meta.url]) {
    try {
      return createRequire(base).resolve("typescript/lib/tsserver.js");
    } catch {
      // Not installed from this location.
    }
  }
  throw new TsServerUnavailableError("TypeScript is not installed in this workspace or the app.");
}

class TsServerProcess {
  private child: ChildProcess | null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextSeq = 1;
  private readonly pending = new Map<
    number,
    { resolve(body: unknown): void; reject(error: Error): void }
  >();
  /** Every file opened on this server; true when its text is an unsaved editor buffer. */
  private readonly openFiles = new Map<string, boolean>();
  private idleTimer: NodeJS.Timeout | null = null;
  private exited = false;

  constructor(
    readonly cwd: string,
    tsserverPath: string,
    private readonly onExit: () => void,
  ) {
    const launch = buildSelfNodeCommand([
      tsserverPath,
      "--disableAutomaticTypingAcquisition",
      "--suppressDiagnosticEvents",
    ]);
    this.child = spawn(launch.command, launch.args, {
      cwd,
      env: launch.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
    trackChildProcess(this.child, {
      command: "tsserver",
      args: ["--disableAutomaticTypingAcquisition", "--suppressDiagnosticEvents"],
      purpose: NETWORK_PURPOSE.languageServer,
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stdin?.on("error", () => undefined);
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => this.fail(new TsServerUnavailableError("tsserver exited.")));
    this.send("configure", {
      hostInfo: "pimi",
      preferences: { providePrefixAndSuffixTextForRename: true },
    });
    this.touch();
  }

  get alive(): boolean {
    return !this.exited;
  }

  /**
   * Opens `file` so the project loads. With the editor's unsaved buffer that content is the
   * file's text; without it the file is re-read from disk. tsserver keeps an open file's text
   * until told otherwise, so every other open file that is not a buffer is reloaded too.
   */
  async syncFile(file: string, content: string | undefined): Promise<void> {
    for (const [open, isBuffer] of this.openFiles) {
      if (open !== file && !isBuffer) this.send("reload", { file: open, tmpfile: open });
    }
    if (content !== undefined) {
      this.openFiles.set(file, true);
      this.send("open", { file, fileContent: content, projectRootPath: this.cwd });
      return;
    }
    if (this.openFiles.has(file)) {
      this.openFiles.set(file, false);
      this.send("reload", { file, tmpfile: file });
      return;
    }
    this.openFiles.set(file, false);
    this.send("open", { file, projectRootPath: this.cwd });
  }

  /** True while a request is waiting for an answer. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  request(command: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolveRequest, reject) => {
      if (this.exited) {
        reject(new TsServerUnavailableError("tsserver is not running."));
        return;
      }
      const seq = this.send(command, args);
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new TsServerUnavailableError(`TypeScript did not answer within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: (body) => {
          clearTimeout(timer);
          resolveRequest(body);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    if (!child || this.exited) return;
    this.fail(new TsServerUnavailableError("tsserver was stopped."));
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS).unref();
  }

  private send(command: string, args: Record<string, unknown>): number {
    const seq = this.nextSeq++;
    this.touch();
    this.child?.stdin?.write(
      `${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`,
    );
    return seq;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), SERVER_IDLE_MS);
    this.idleTimer.unref();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(length)) {
        // Not framed output (a stray log line); drop through the next blank line.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.dispatch(body);
    }
  }

  private dispatch(raw: string): void {
    let message: TsResponse;
    try {
      message = JSON.parse(raw) as TsResponse;
    } catch {
      return;
    }
    if (message.type !== "response" || message.request_seq === undefined) return;
    const waiting = this.pending.get(message.request_seq);
    if (!waiting) return;
    this.pending.delete(message.request_seq);
    if (message.success) waiting.resolve(message.body);
    else waiting.reject(new Error(message.message ?? "TypeScript rejected the request."));
  }

  private fail(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.child = null;
    this.onExit();
  }
}

const servers = new Map<string, TsServerProcess>();

function serverFor(workspaceId: string, cwd: string): TsServerProcess {
  const existing = servers.get(workspaceId);
  if (existing?.alive && existing.cwd === cwd) {
    // Map order is recency: re-insert so the least recently used is first.
    servers.delete(workspaceId);
    servers.set(workspaceId, existing);
    return existing;
  }
  existing?.stop();
  const server = new TsServerProcess(cwd, resolveTsServerPath(cwd), () => {
    if (servers.get(workspaceId) === server) servers.delete(workspaceId);
  });
  servers.delete(workspaceId);
  servers.set(workspaceId, server);
  for (const [id, oldest] of servers) {
    if (servers.size <= MAX_SERVERS) break;
    // A server answering a request is kept; the cap is met by the next query.
    if (oldest === server || oldest.busy) continue;
    oldest.stop();
    servers.delete(id);
  }
  return server;
}

/** Stops the workspace's tsserver, when the workspace is archived. */
export function closeTsServer(workspaceId: string): void {
  servers.get(workspaceId)?.stop();
  servers.delete(workspaceId);
}

export function closeAllTsServers(): void {
  for (const server of servers.values()) server.stop();
  servers.clear();
}

function insideWorkspace(cwd: string, file: string): string | null {
  const rel = relative(cwd, file);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
}

function previewOf(text: string): string {
  return text.trim().slice(0, MAX_PREVIEW_CHARS);
}

const lineCache = new Map<string, string[] | null>();

async function lineText(file: string, line: number): Promise<string> {
  let lines = lineCache.get(file);
  if (lines === undefined) {
    lines = await readFile(file, "utf8")
      .then((text) => text.split("\n"))
      .catch(() => null);
    lineCache.set(file, lines);
  }
  return previewOf(lines?.[line - 1] ?? "");
}

function displayPath(cwd: string, file: string): string {
  // A definition in a dependency's typings lies outside the workspace; it keeps its absolute path.
  return insideWorkspace(cwd, file) ?? file;
}

async function toLocations(
  cwd: string,
  items: Array<{ file: string; start: TsPosition; lineText?: string; isDefinition?: boolean }>,
  forceDefinition: boolean,
): Promise<{ results: CodeNavigationLocation[]; truncated: boolean }> {
  const results: CodeNavigationLocation[] = [];
  for (const item of items.slice(0, MAX_RESULTS)) {
    results.push({
      path: displayPath(cwd, item.file),
      line: item.start.line,
      column: item.start.offset,
      preview: item.lineText
        ? previewOf(item.lineText)
        : await lineText(item.file, item.start.line),
      role: forceDefinition || item.isDefinition ? "definition" : "reference",
    });
  }
  return { results, truncated: items.length > MAX_RESULTS };
}

interface RenameBody {
  info: { canRename: boolean; localizedErrorMessage?: string };
  locs: Array<{ file: string; locs: TsSpan[] }>;
}

function toEdits(cwd: string, body: RenameBody, newName: string): CodeNavigationEdit[] {
  const edits: CodeNavigationEdit[] = [];
  for (const group of body.locs) {
    const path = insideWorkspace(cwd, group.file);
    if (!path) throw new Error("Renaming would change files outside this workspace.");
    for (const span of group.locs) {
      edits.push({
        path,
        line: span.start.line,
        column: span.start.offset,
        endLine: span.end.line,
        endColumn: span.end.offset,
        newText: `${span.prefixText ?? ""}${newName}${span.suffixText ?? ""}`,
      });
    }
  }
  if (edits.length > MAX_EDITS)
    throw new Error(`Renaming would make ${edits.length} edits; too many.`);
  return edits;
}

/** Answers definition, references and rename from tsserver. Throws when it cannot. */
export async function queryTsServer(query: CodeNavigationQuery): Promise<ProviderResult> {
  const file = resolve(query.cwd, query.path);
  if (!insideWorkspace(query.cwd, file)) {
    throw new TsServerUnavailableError("The file is outside this workspace.");
  }
  lineCache.clear();
  const server = serverFor(query.workspaceId, query.cwd);
  await server.syncFile(file, query.content);
  const position = { file, line: query.line, offset: query.column };

  if (query.kind === "rename") {
    const body = (await server.request(
      "rename",
      { ...position, findInStrings: false, findInComments: false },
      RENAME_TIMEOUT_MS,
    )) as RenameBody;
    if (!body.info.canRename) {
      throw new Error(body.info.localizedErrorMessage ?? "This symbol cannot be renamed.");
    }
    const edits = toEdits(query.cwd, body, query.newName ?? query.symbol);
    return {
      provider: "typescript",
      serverName: "TypeScript",
      note: null,
      results: [],
      truncated: false,
      edits,
    };
  }

  if (query.kind === "definition") {
    const body = (await server.request("definition", position, NAVIGATION_TIMEOUT_MS)) as Array<{
      file: string;
      start: TsPosition;
    }>;
    const located = await toLocations(query.cwd, body, true);
    return { provider: "typescript", serverName: "TypeScript", note: null, ...located, edits: [] };
  }

  const body = (await server.request("references", position, NAVIGATION_TIMEOUT_MS)) as {
    refs: Array<{ file: string; start: TsPosition; lineText?: string; isDefinition?: boolean }>;
  };
  const located = await toLocations(query.cwd, body.refs, false);
  return { provider: "typescript", serverName: "TypeScript", note: null, ...located, edits: [] };
}
