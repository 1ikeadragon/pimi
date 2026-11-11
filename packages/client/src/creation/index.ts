import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  WorkspaceCreateResponse,
} from "@pimi/protocol/messages";
import type { CreateAgentRequestOptions, CreateWorkspaceRequestOptions } from "../daemon-client.js";

type Kind = CreationSnapshot["kind"];
type Observer = (snapshot: CreationSnapshot) => void;
export interface CreationResult {
  agent?: AgentSnapshotPayload | null;
  workspace?: WorkspaceCreateResponse["payload"]["workspace"];
  creation?: CreationSnapshot;
  error: string | null;
  errorCode?: string;
  setupTerminalId?: string | null;
  setupSkippedReason?: string;
  requestId?: string;
}
interface Dependencies {
  requestId: () => string;
  request: (kind: Kind, input: Record<string, unknown>) => Promise<CreationResult>;
  observe: (
    kind: Kind,
    key: string,
    next: (snapshot: CreationSnapshot | null) => void,
    error: (error: unknown) => void,
  ) => () => void;
}
interface Operation {
  kind: Kind;
  key: string;
  fingerprint: string;
  input: Record<string, unknown>;
  observers: Set<Observer>;
  snapshot?: CreationSnapshot;
  result: Promise<CreationResult>;
  resolve: (result: CreationResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
  recovering: boolean;
  stopObserving?: () => void;
}

/** Client-owned observation. UI callbacks never advance creation. */
export class CreationClient {
  private readonly operations = new Map<string, Operation>();
  constructor(private readonly deps: Dependencies) {}

  createAgent(input: CreateAgentRequestOptions): Promise<CreationResult> {
    const { onEvent, ...request } = input;
    return this.start("agent", request, onEvent);
  }
  createWorkspace(input: CreateWorkspaceRequestOptions): Promise<CreationResult> {
    const { onEvent, ...request } = input;
    return this.start("workspace", request, onEvent);
  }

  private start(
    kind: Kind,
    input: Record<string, unknown>,
    observer: Observer | undefined,
  ): Promise<CreationResult> {
    const key =
      typeof input.idempotencyKey === "string" ? input.idempotencyKey : this.deps.requestId();
    const identity = JSON.stringify([kind, key]);
    const { requestId: _requestId, ...intent } = input;
    const fingerprint = JSON.stringify(intent, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
    );
    const previous = this.operations.get(identity);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return Promise.reject(new Error(`${kind}_request_key_conflict`));
      if (observer) {
        previous.observers.add(observer);
        if (previous.snapshot) this.notify(observer, previous.snapshot);
      }
      return previous.result;
    }
    let resolve!: Operation["resolve"];
    let reject!: Operation["reject"];
    const result = new Promise<CreationResult>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const operation: Operation = {
      kind,
      key,
      input: { ...input, idempotencyKey: key },
      fingerprint,
      observers: new Set(observer ? [observer] : []),
      result,
      resolve,
      reject,
      settled: false,
      recovering: false,
    };
    this.operations.set(identity, operation);
    void this.submit(operation);
    return result;
  }

  private async submit(operation: Operation): Promise<void> {
    try {
      const result = await this.deps.request(operation.kind, {
        ...operation.input,
        subscribe: true,
      });
      if (result.creation) this.receive(result.creation);
      this.finish(operation, result);
    } catch (error) {
      if (
        operation.settled ||
        (error instanceof Error && "code" in error && error.code === "DAEMON_CONNECTION_LOST")
      )
        return;
      this.fail(operation, error);
    }
  }
  receive(snapshot: CreationSnapshot): void {
    const operation = this.operations.get(JSON.stringify([snapshot.kind, snapshot.idempotencyKey]));
    if (!operation || (operation.snapshot && operation.snapshot.revision > snapshot.revision))
      return;
    if (operation.snapshot?.revision !== snapshot.revision) {
      operation.snapshot = snapshot;
      for (const observer of operation.observers) this.notify(observer, snapshot);
    }
    if (operation.recovering && (snapshot.phase === "completed" || snapshot.phase === "failed")) {
      this.finish(operation, {
        agent: snapshot.agent,
        workspace: snapshot.workspace,
        creation: snapshot,
        setupSkippedReason: snapshot.setupSkippedReason,
        error: snapshot.error,
        errorCode: snapshot.errorCode,
      });
    }
  }
  reconnect(): void {
    for (const operation of this.operations.values()) {
      if (operation.settled || operation.recovering) continue;
      operation.recovering = true;
      operation.stopObserving = this.deps.observe(
        operation.kind,
        operation.key,
        (snapshot) => {
          if (!snapshot) void this.submit(operation);
          else {
            // Re-subscription is authoritative even if its revision matches the last live event.
            this.receive(snapshot);
          }
        },
        (error) => this.fail(operation, error),
      );
    }
  }
  close(): void {
    for (const operation of this.operations.values())
      if (!operation.settled) this.fail(operation, new Error("Daemon client closed"));
    this.operations.clear();
  }
  private finish(operation: Operation, result: CreationResult): void {
    if (operation.settled) return;
    operation.settled = true;
    operation.stopObserving?.();
    operation.resolve(result);
    operation.observers.clear();
    this.operations.delete(JSON.stringify([operation.kind, operation.key]));
  }
  private fail(operation: Operation, error: unknown): void {
    if (operation.settled) return;
    operation.settled = true;
    operation.stopObserving?.();
    operation.reject(error instanceof Error ? error : new Error(String(error)));
    operation.observers.clear();
    this.operations.delete(JSON.stringify([operation.kind, operation.key]));
  }
  private notify(observer: Observer, snapshot: CreationSnapshot): void {
    try {
      observer(snapshot);
    } catch {
      /* Observation does not control execution. */
    }
  }
}
