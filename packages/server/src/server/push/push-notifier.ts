import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { sealPushPreview, type PushPreviewReason } from "./push-preview-seal.js";

export type PushKind = "agent_finished" | "agent_permission" | "terminal";

const HANDLES_FILENAME = "push-handles.json";
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PREVIEW_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// One handle per paired phone; bounds the store and the fan-out when nobody is present.
const MAX_HANDLES = 32;
const SEND_TIMEOUT_MS = 5_000;
// Body length for the second sealing attempt when the full message does not fit.
const SHORT_BODY_CHARS = 120;
const RECENT_TS_KEPT = 32;
const WORKSPACE_ID_PATTERN = /^[\w-]{1,128}$/;

/** One paired phone: its push handle and, when it wants previews, the key it seals them with. */
interface PushDevice {
  handle: string;
  previewKey: string | null;
}

/** What an attention push says. Reaches the phone only as ciphertext, never the push service. */
export interface PushPreview {
  reason: PushPreviewReason;
  title: string;
  body: string;
}

interface PushSend {
  handle: string;
  kind: PushKind;
  id: string;
  title: string | null;
  workspaceId: string | null;
  enc: string | null;
}

interface PushNotifierOptions {
  pimiHome: string;
  logger: pino.Logger;
  /** Push service URL while the relay is enabled, null otherwise. */
  getEndpoint: () => string | null;
}

/**
 * Daemon side of Android push: owns the handles phones registered and asks the push service to
 * deliver a notification. Phones that registered a preview key get the chat name and message
 * sealed into one AES-GCM blob the push service and Google cannot read; the rest get the chat or
 * terminal name in the clear. Handles and keys are bearer secrets, so they are persisted in a
 * private file and never logged. Sends are fire-and-forget; callers never wait on the network.
 */
export class PushNotifier {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private readonly getEndpoint: () => string | null;
  private devices: PushDevice[];
  // Recent timestamps sealed per handle. The phone rejects an exact repeat, so a collision (two
  // pushes in one millisecond, or a clock stepped back) is bumped to the next free value.
  private readonly recentTs = new Map<string, number[]>();

  constructor(options: PushNotifierOptions) {
    this.filePath = path.join(options.pimiHome, HANDLES_FILENAME);
    this.logger = options.logger.child({ module: "push" });
    this.getEndpoint = options.getEndpoint;
    this.devices = this.load();
  }

  private load(): PushDevice[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        devices?: unknown;
        handles?: unknown;
      };
      // COMPAT(push-handles.json v1): `{ version: 1, handles: [...] }` had no preview keys. Phones
      // re-send theirs on the next connect; until then they get generic notifications.
      let rows: unknown = parsed.devices;
      if (!Array.isArray(rows) && Array.isArray(parsed.handles)) {
        rows = parsed.handles.map((handle) => ({ handle, previewKey: null }));
      }
      if (!Array.isArray(rows)) return [];
      const devices: PushDevice[] = [];
      for (const entry of rows as Array<Partial<PushDevice> | null>) {
        if (typeof entry?.handle !== "string" || !HANDLE_PATTERN.test(entry.handle)) continue;
        const previewKey =
          typeof entry.previewKey === "string" && PREVIEW_KEY_PATTERN.test(entry.previewKey)
            ? entry.previewKey
            : null;
        devices.push({ handle: entry.handle, previewKey });
      }
      return devices.slice(0, MAX_HANDLES);
    } catch (error) {
      this.logger.warn({ err: error }, "Ignoring unreadable push handle store");
      return [];
    }
  }

  private persist(): void {
    writePrivateFileAtomicSync(
      this.filePath,
      JSON.stringify({ version: 2, devices: this.devices }),
    );
  }

  hasHandle(handle: string): boolean {
    return this.devices.some((device) => device.handle === handle);
  }

  /** Registers or updates a phone. A null key means it wants generic notifications. */
  upsert(handle: string, previewKey: string | null): void {
    const existing = this.devices.find((device) => device.handle === handle);
    if (existing) {
      if (existing.previewKey === previewKey) return;
      existing.previewKey = previewKey;
      this.recentTs.delete(handle);
    } else {
      // Newest wins when full: the oldest handle belongs to the phone least likely to still be paired.
      this.devices = [...this.devices, { handle, previewKey }].slice(-MAX_HANDLES);
    }
    this.persist();
  }

  remove(handle: string): void {
    if (!this.hasHandle(handle)) return;
    this.devices = this.devices.filter((device) => device.handle !== handle);
    this.recentTs.delete(handle);
    this.persist();
  }

  /** Forgets every phone, so a revoked device stops receiving pushes (and keeps no usable key). */
  clear(): void {
    this.devices = [];
    this.recentTs.clear();
    this.persist();
  }

  /** Push to the given handles, or to every stored handle when `handles` is null. */
  notify(input: {
    handles: string[] | null;
    kind: PushKind;
    id: string;
    title: string | null;
    workspaceId?: string | null;
    preview?: PushPreview;
  }): void {
    const endpoint = this.getEndpoint();
    if (!endpoint) return;
    const targets = input.handles
      ? this.devices.filter((device) => input.handles?.includes(device.handle))
      : this.devices;
    for (const device of targets) {
      const enc = input.preview ? this.seal(device, input.id, input.preview) : null;
      // A device that holds a preview key never gets the chat name in the clear for an agent
      // push: it travels sealed, and when sealing fails the push goes out generic.
      const keyed = Boolean(input.preview && device.previewKey);
      void this.send(endpoint, {
        handle: device.handle,
        kind: input.kind,
        id: input.id,
        title: enc || keyed ? null : input.title,
        workspaceId: input.workspaceId ?? null,
        enc,
      });
    }
  }

  private seal(device: PushDevice, agentId: string, preview: PushPreview): string | null {
    if (!device.previewKey) return null;
    const ts = this.nextTs(device.handle);
    const seal = (body: string) =>
      sealPushPreview({ key: device.previewKey as string, agentId, ts, ...preview, body });
    const sealed = seal(preview.body);
    if (sealed) return sealed;
    // Too big for the push service (wide characters): retry with a shorter message.
    const shortened = seal(Array.from(preview.body).slice(0, SHORT_BODY_CHARS).join(""));
    if (!shortened)
      this.logger.warn({ kind: "preview" }, "Preview too large to seal; sending generic");
    return shortened;
  }

  private nextTs(handle: string): number {
    const used = this.recentTs.get(handle) ?? [];
    let ts = Date.now();
    while (used.includes(ts)) ts += 1;
    this.recentTs.set(handle, [...used, ts].slice(-RECENT_TS_KEPT));
    return ts;
  }

  private async send(endpoint: string, push: PushSend): Promise<void> {
    const { handle, kind, id, title, workspaceId, enc } = push;
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
          ...(enc ? { enc } : {}),
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
