import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { writePrivateFileAtomicSync } from "../private-files.js";

export type PushKind = "agent_finished" | "agent_permission" | "terminal";

const HANDLES_FILENAME = "push-handles.json";
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// One handle per paired phone; bounds the store and the fan-out when nobody is present.
const MAX_HANDLES = 32;
const SEND_TIMEOUT_MS = 5_000;
const WORKSPACE_ID_PATTERN = /^[\w-]{1,128}$/;

interface PushNotifierOptions {
  pimiHome: string;
  logger: pino.Logger;
  /** Push service URL while the relay is enabled, null otherwise. */
  getEndpoint: () => string | null;
}

/**
 * Daemon side of Android push: owns the handles phones registered and asks the push service to
 * deliver a notification titled with the chat or terminal name. Handles are bearer capabilities, so they are persisted in a
 * private file and never logged. Sends are fire-and-forget; callers never wait on the network.
 */
export class PushNotifier {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private readonly getEndpoint: () => string | null;
  private handles: string[];

  constructor(options: PushNotifierOptions) {
    this.filePath = path.join(options.pimiHome, HANDLES_FILENAME);
    this.logger = options.logger.child({ module: "push" });
    this.getEndpoint = options.getEndpoint;
    this.handles = this.load();
  }

  private load(): string[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as { handles?: unknown };
      if (!Array.isArray(parsed.handles)) return [];
      return parsed.handles
        .filter((value): value is string => typeof value === "string" && HANDLE_PATTERN.test(value))
        .slice(0, MAX_HANDLES);
    } catch (error) {
      this.logger.warn({ err: error }, "Ignoring unreadable push handle store");
      return [];
    }
  }

  private persist(): void {
    writePrivateFileAtomicSync(
      this.filePath,
      JSON.stringify({ version: 1, handles: this.handles }),
    );
  }

  hasHandle(handle: string): boolean {
    return this.handles.includes(handle);
  }

  add(handle: string): void {
    if (this.handles.includes(handle)) return;
    // Newest wins when full: the oldest handle belongs to the phone least likely to still be paired.
    this.handles = [...this.handles, handle].slice(-MAX_HANDLES);
    this.persist();
  }

  remove(handle: string): void {
    if (!this.handles.includes(handle)) return;
    this.handles = this.handles.filter((existing) => existing !== handle);
    this.persist();
  }

  /** Push to the given handles, or to every stored handle when `handles` is null. */
  notify(input: {
    handles: string[] | null;
    kind: PushKind;
    id: string;
    title: string | null;
    workspaceId?: string | null;
  }): void {
    const endpoint = this.getEndpoint();
    if (!endpoint) return;
    const targets = input.handles ?? this.handles;
    for (const handle of targets) {
      void this.send(
        endpoint,
        handle,
        input.kind,
        input.id,
        input.title,
        input.workspaceId ?? null,
      );
    }
  }

  private async send(
    endpoint: string,
    handle: string,
    kind: PushKind,
    id: string,
    title: string | null,
    workspaceId: string | null,
  ): Promise<void> {
    try {
      const response = await fetch(`${endpoint}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The push service trims the title; cap it here too so a huge name never hits its body limit.
        body: JSON.stringify({
          handle,
          kind,
          id,
          ...(title ? { title: title.slice(0, 200) } : {}),
          // The push service rejects ids outside this shape; drop it rather than lose the push.
          ...(workspaceId && WORKSPACE_ID_PATTERN.test(workspaceId) ? { workspaceId } : {}),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 410) {
        this.remove(handle);
        this.logger.info({ kind }, "Push handle gone; pruned");
      } else if (!response.ok) {
        this.logger.warn({ kind, status: response.status }, "Push send rejected");
      }
    } catch (error) {
      // fetch errors name the URL only; the handle travels in the body and never reaches the error.
      this.logger.warn({ kind, err: error }, "Push send failed");
    }
  }
}
