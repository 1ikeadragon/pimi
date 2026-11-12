import type { ChildProcess } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnProcess } from "../../utils/spawn.js";
import { NETWORK_PURPOSE } from "@pimi/protocol/network-activity";

// A hand-written Language Server Protocol client over stdio: `Content-Length` framed JSON-RPC,
// `initialize`/`initialized`, full-text `didOpen`/`didChange`, and the requests the editor needs.

const STOP_GRACE_MS = 2_000;
const CONTENT_MODIFIED = -32801;
const SERVER_CANCELLED = -32802;
const CONTENT_MODIFIED_RETRIES = 4;
const RETRY_DELAY_MS = 300;
// A server that has not reported a status this long after starting is taken to be ready.
const STATUS_GRACE_MS = 1_500;

export class LspUnavailableError extends Error {}

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<
    { textDocument: { uri: string }; edits: LspTextEdit[] } | { kind: string }
  >;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export function pathToUri(path: string): string {
  return pathToFileURL(path).href;
}

export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

export class LspProcess {
  private child: ChildProcess | null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(result: unknown): void; reject(error: Error): void }
  >();
  private readonly documents = new Map<string, { version: number; text: string }>();
  private ready: Promise<void>;
  private exited = false;
  private capabilities: Record<string, unknown> = {};
  /** What the server called itself in `initialize`, once it has answered. */
  serverInfo: { name?: string; version?: string } | null = null;
  /** False until the server has answered one request after starting; the first can be slow. */
  warm = false;
  // rust-analyzer reports `experimental/serverStatus` while it loads the project and answers
  // empty until it is done. Null for servers that never report one.
  private quiescent: boolean | null = null;
  private initializedAt = 0;

  constructor(
    readonly root: string,
    launch: { executable: string; args: string[] },
    private readonly onExit: () => void,
  ) {
    this.child = spawnProcess(launch.executable, launch.args, {
      cwd: root,
      networkPurpose: NETWORK_PURPOSE.languageServer,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stdin?.on("error", () => undefined);
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => this.fail(new LspUnavailableError("The language server exited.")));
    this.ready = this.initialize();
    // A failed start rejects every request through `ready`; this keeps the rejection handled.
    this.ready.catch(() => undefined);
  }

  get alive(): boolean {
    return !this.exited;
  }

  private async initialize(): Promise<void> {
    const rootUri = pathToUri(this.root);
    const result = (await this.rawRequest("initialize", {
      processId: process.pid,
      clientInfo: { name: "pimi" },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: this.root.split(/[\\/]/).pop() || "workspace" }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        window: { workDoneProgress: true },
        experimental: { serverStatusNotification: true },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          workspaceEdit: { documentChanges: true },
        },
        textDocument: {
          synchronization: { didSave: false },
          definition: { linkSupport: true },
          references: {},
          rename: { prepareSupport: true },
        },
      },
    })) as {
      capabilities?: Record<string, unknown>;
      serverInfo?: { name?: string; version?: string };
    } | null;
    this.capabilities = result?.capabilities ?? {};
    this.serverInfo = result?.serverInfo ?? null;
    this.notify("initialized", {});
    this.initializedAt = Date.now();
  }

  /** Waits for a cold server to finish loading its project, bounded by `timeoutMs`. */
  private async settled(timeoutMs: number): Promise<void> {
    if (this.warm) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.exited) {
      if (this.quiescent === true) return;
      if (this.quiescent === null && Date.now() - this.initializedAt > STATUS_GRACE_MS) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Resolves when the server has answered `initialize`; rejects if it could not start. */
  whenReady(timeoutMs: number): Promise<void> {
    return this.withTimeout(this.ready, timeoutMs, "start");
  }

  /** Brings the server's copy of `path` to `text`, opening it first if needed. */
  async syncDocument(path: string, languageId: string, text: string): Promise<string> {
    await this.ready;
    const uri = pathToUri(path);
    const known = this.documents.get(uri);
    if (!known) {
      this.documents.set(uri, { version: 1, text });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
    } else if (known.text !== text) {
      known.version += 1;
      known.text = text;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: known.version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    await this.withTimeout(this.ready, timeoutMs, "start");
    await this.settled(timeoutMs);
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.withTimeout(this.rawRequest(method, params), timeoutMs, method);
        this.warm = true;
        return result;
      } catch (error) {
        const retryable =
          error instanceof RpcError &&
          (error.code === CONTENT_MODIFIED || error.code === SERVER_CANCELLED);
        if (!retryable || attempt >= CONTENT_MODIFIED_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  supportsPrepareRename(): boolean {
    const provider = this.capabilities.renameProvider;
    return (
      typeof provider === "object" &&
      provider !== null &&
      Boolean(Reflect.get(provider, "prepareProvider"))
    );
  }

  stop(): void {
    const child = this.child;
    if (!child || this.exited) return;
    // Polite shutdown first; the process is killed if it does not leave in time.
    this.rawRequest("shutdown", null)
      .then(() => this.notify("exit", undefined))
      .catch(() => undefined);
    this.fail(new LspUnavailableError("The language server was stopped."));
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
    child.kill("SIGTERM");
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new LspUnavailableError(
              `The language server did not answer (${what}) within ${timeoutMs} ms.`,
            ),
          ),
        timeoutMs,
      );
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
          return value;
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private rawRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new LspUnavailableError("The language server is not running."));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: object): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child?.stdin?.write(
      Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]),
    );
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = Number(
        /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString("ascii"))?.[1],
      );
      if (!Number.isFinite(length)) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const raw = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.dispatch(JSON.parse(raw) as RpcMessage);
      } catch {
        // A malformed message is dropped; the stream stays in sync by length.
      }
    }
  }

  private dispatch(message: RpcMessage): void {
    if (message.method !== undefined) {
      if (message.id !== undefined) this.answerServerRequest(message);
      else if (message.method === "experimental/serverStatus") {
        this.quiescent = Boolean(
          (message.params as { quiescent?: boolean } | undefined)?.quiescent,
        );
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    if (message.error) waiting.reject(new RpcError(message.error.message, message.error.code));
    else waiting.resolve(message.result ?? null);
  }

  /** Servers ask the client for configuration and to register capabilities; none is needed here. */
  private answerServerRequest(message: RpcMessage): void {
    let result: unknown = null;
    if (message.method === "workspace/configuration") {
      const items = (message.params as { items?: unknown[] } | undefined)?.items ?? [];
      result = items.map(() => null);
    }
    this.write({ jsonrpc: "2.0", id: message.id, result });
  }

  private fail(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.child = this.child && null;
    this.onExit();
  }
}
