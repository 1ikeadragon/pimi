import { randomUUID } from "node:crypto";
import {
  DesktopTargetExecuteRequestSchema,
  DesktopTargetExecuteResponseSchema,
  type DesktopTargetCommand,
  type DesktopTargetExecuteRequest,
  type DesktopTargetExecuteResponse,
} from "@pimi/protocol/desktop-target/rpc-schemas";

export type DesktopToolsPayload = DesktopTargetExecuteResponse["payload"];
export type DesktopToolsGuard = NonNullable<DesktopTargetExecuteRequest["guard"]>;

export interface DesktopHostClient {
  id: string;
  hostKind: string;
  sendDesktopTargetRequest(request: DesktopTargetExecuteRequest): void | Promise<void>;
}

export interface DesktopToolsExecuteInput {
  command: DesktopTargetCommand;
  agentId: string;
  /** Built by the daemon from the run, never from agent input. The desktop app enforces it. */
  guard: DesktopToolsGuard;
  timeoutMs?: number;
}

interface Pending {
  clientId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (payload: DesktopToolsPayload) => void;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function desktopFailure(
  requestId: string,
  code: Extract<DesktopToolsPayload, { ok: false }>["error"]["code"],
  message: string,
): DesktopToolsPayload {
  return { requestId, ok: false, error: { code, message } };
}

/** Hands `desktop_*` tool calls to the desktop app that registered as the desktop host. */
export class DesktopToolsBroker {
  private readonly clients = new Map<string, { client: DesktopHostClient; seq: number }>();
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;

  registerClient(client: DesktopHostClient): () => void {
    this.unregisterClient(client.id);
    const seq = ++this.sequence;
    this.clients.set(client.id, { client, seq });
    return () => this.unregisterClient(client.id, seq);
  }

  unregisterClient(clientId: string, seq?: number): void {
    const current = this.clients.get(clientId);
    if (!current || (seq !== undefined && current.seq !== seq)) return;
    this.clients.delete(clientId);
    for (const [requestId, pending] of this.pending) {
      if (pending.clientId !== clientId) continue;
      this.settle(
        requestId,
        desktopFailure(requestId, "failed", "The desktop app disconnected before responding."),
      );
    }
  }

  hasHost(): boolean {
    return this.clients.size > 0;
  }

  async execute(input: DesktopToolsExecuteInput): Promise<DesktopToolsPayload> {
    const requestId = `desktop_${randomUUID()}`;
    const parsed = DesktopTargetExecuteRequestSchema.safeParse({
      type: "desktop.target.execute.request",
      requestId,
      agentId: input.agentId,
      guard: input.guard,
      command: input.command,
    });
    if (!parsed.success) {
      return desktopFailure(
        requestId,
        "failed",
        `Desktop request is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}.`,
      );
    }
    let selected: { client: DesktopHostClient; seq: number } | null = null;
    for (const entry of this.clients.values()) selected = entry;
    if (!selected) {
      return desktopFailure(
        requestId,
        "unsupported",
        "No desktop app is connected, so there is no window to drive.",
      );
    }
    const client = selected.client;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<DesktopToolsPayload>((resolve) => {
      const timeout = setTimeout(
        () =>
          this.settle(
            requestId,
            desktopFailure(
              requestId,
              "failed",
              `The desktop app did not answer in ${timeoutMs}ms.`,
            ),
          ),
        timeoutMs,
      );
      this.pending.set(requestId, { clientId: client.id, timeout, resolve });
      const fail = (error: unknown) =>
        this.settle(
          requestId,
          desktopFailure(
            requestId,
            "failed",
            `Desktop request failed to send: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      try {
        Promise.resolve(client.sendDesktopTargetRequest(parsed.data)).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  // The one place a pending request is answered, so it is answered once.
  private settle(requestId: string, payload: DesktopToolsPayload): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(payload);
    return true;
  }

  /** Only the host that was sent the request may answer it. */
  receiveResponse(response: DesktopTargetExecuteResponse, clientIds?: readonly string[]): boolean {
    const parsed = DesktopTargetExecuteResponseSchema.safeParse(response);
    const requestId = parsed.success
      ? parsed.data.payload.requestId
      : (response as { payload?: { requestId?: unknown } }).payload?.requestId;
    if (typeof requestId !== "string") return false;
    const pending = this.pending.get(requestId);
    if (!pending || (clientIds && !clientIds.includes(pending.clientId))) return false;
    return this.settle(
      requestId,
      parsed.success
        ? parsed.data.payload
        : desktopFailure(requestId, "failed", "The desktop app sent an invalid response."),
    );
  }
}
