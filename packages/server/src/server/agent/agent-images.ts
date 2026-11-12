import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentImageRef, ProviderImageSource } from "@pimi/protocol/agent-types";
import { runJsonImportOnce, type PimiDatabase } from "../db/pimi-db.js";

/**
 * Image bytes an agent's messages refer to, by content hash. Message records keep only the
 * ids, so a timeline row stays small and any client fetches the bytes on demand.
 */

export const MAX_AGENT_IMAGE_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const IMAGE_ID_PATTERN = /^[0-9a-f]{64}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export type AgentImageOrigin = "user" | "agent";

export type ProviderImageOutput = ProviderImageSource;

export function isSupportedImageMimeType(mimeType: string): boolean {
  return mimeType in EXTENSIONS;
}

export function agentImageId(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The type the bytes really are. Declared types and file extensions are not trusted. */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  const at = (offset: number, ...values: number[]) =>
    values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (
    at(0, 0x47, 0x49, 0x46, 0x38) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  )
    return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

function imageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const valid = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;
  try {
    if (mimeType === "image/png") return valid(view.getUint32(16), view.getUint32(20));
    if (mimeType === "image/gif") return valid(view.getUint16(6, true), view.getUint16(8, true));
    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return valid(view.getUint16(offset + 7), view.getUint16(offset + 5));
        }
        offset += 2 + view.getUint16(offset + 2);
      }
      return null;
    }
    if (mimeType === "image/webp") {
      const kind = String.fromCharCode(...bytes.slice(12, 16));
      if (kind === "VP8X") {
        const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
        const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
        return valid(width, height);
      }
      if (kind === "VP8 ") {
        return valid(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
      }
      if (kind === "VP8L") {
        const bits = view.getUint32(21, true);
        return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
    }
  } catch {
    /* A truncated header only costs the layout hint. */
  }
  return null;
}

export interface AgentImageStore {
  put(
    agentId: string,
    input: { bytes: Uint8Array; mimeType: string; origin: AgentImageOrigin },
  ): Promise<AgentImageRef>;
  read(agentId: string, imageId: string): Promise<{ mimeType: string; bytes: Buffer } | null>;
  delete(agentId: string): Promise<void>;
}

// Legacy per-agent index.json, read only by the one-time import.
const INDEX_SCHEMA = z.object({
  version: z.literal(1),
  images: z.record(
    z.string(),
    z.object({ mimeType: z.string(), origin: z.enum(["user", "agent"]) }),
  ),
});

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// Image bytes are files under <directory>/<agentId>/<imageId>.<ext>; which images an agent has,
// and their type and origin, are rows of agent_image_index.
export class FileAgentImageStore implements AgentImageStore {
  private readonly logger: Logger;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly database: PimiDatabase,
    private readonly directory: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "agent", component: "agent-images" });
  }

  // Each <agentId>/index.json is imported once and renamed to index.json.migrated; the image
  // files stay where they are.
  async importLegacy(): Promise<void> {
    const rows: Array<{ agentId: string; imageId: string; mimeType: string; origin: string }> = [];
    const legacyPaths: string[] = [];
    let agents: string[] = [];
    try {
      agents = await fs.readdir(this.directory);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    for (const agentId of agents) {
      const indexPath = path.join(this.directory, agentId, "index.json");
      try {
        const parsed = INDEX_SCHEMA.parse(JSON.parse(await fs.readFile(indexPath, "utf8")));
        for (const [imageId, entry] of Object.entries(parsed.images)) {
          rows.push({ agentId, imageId, mimeType: entry.mimeType, origin: entry.origin });
        }
        legacyPaths.push(indexPath);
      } catch (error) {
        if (!isMissingFile(error)) {
          this.logger.error({ err: error, agentId }, "Skipping invalid agent image index");
        }
      }
    }
    await runJsonImportOnce(
      this.database,
      { name: "agent-images", legacyPaths, logger: this.logger },
      () => {
        for (const row of rows) {
          this.database.db
            .prepare(
              "INSERT OR IGNORE INTO agent_image_index (agent_id, image_id, mime_type, origin) VALUES (?, ?, ?, ?)",
            )
            .run(row.agentId, row.imageId, row.mimeType, row.origin);
        }
      },
    );
  }

  async put(
    agentId: string,
    input: { bytes: Uint8Array; mimeType: string; origin: AgentImageOrigin },
  ): Promise<AgentImageRef> {
    const imageId = agentImageId(input.bytes);
    const sniffed = sniffImageMimeType(input.bytes);
    if (!sniffed) {
      return {
        imageId,
        mimeType: input.mimeType,
        byteSize: input.bytes.length,
        unavailable: "unsupported",
      };
    }
    const dimensions = imageDimensions(input.bytes, sniffed);
    const ref: AgentImageRef = {
      imageId,
      mimeType: sniffed,
      byteSize: input.bytes.length,
      ...dimensions,
    };
    if (input.bytes.length > MAX_AGENT_IMAGE_BYTES) return { ...ref, unavailable: "too_large" };
    await this.enqueue(agentId, async () => {
      if (this.lookup(agentId, imageId)) return;
      await this.writePrivate(this.imagePath(agentId, imageId, sniffed), input.bytes);
      this.database.db
        .prepare(
          "INSERT OR REPLACE INTO agent_image_index (agent_id, image_id, mime_type, origin) VALUES (?, ?, ?, ?)",
        )
        .run(agentId, imageId, sniffed, input.origin);
    });
    return ref;
  }

  async read(
    agentId: string,
    imageId: string,
  ): Promise<{ mimeType: string; bytes: Buffer } | null> {
    // The id only selects an index entry; the path and mime type come from the daemon.
    if (!IMAGE_ID_PATTERN.test(imageId)) return null;
    const entry = this.lookup(agentId, imageId);
    if (!entry || !isSupportedImageMimeType(entry.mimeType)) return null;
    try {
      return {
        mimeType: entry.mimeType,
        bytes: await fs.readFile(this.imagePath(agentId, imageId, entry.mimeType)),
      };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async delete(agentId: string): Promise<void> {
    await this.enqueue(agentId, async () => {
      this.database.db.prepare("DELETE FROM agent_image_index WHERE agent_id = ?").run(agentId);
      await fs.rm(this.agentDir(agentId), { recursive: true, force: true });
    });
  }

  private enqueue<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    this.queues.set(agentId, tail);
    void tail.finally(() => {
      if (this.queues.get(agentId) === tail) this.queues.delete(agentId);
    });
    return run;
  }

  private lookup(agentId: string, imageId: string): { mimeType: string } | null {
    const row = this.database.db
      .prepare("SELECT mime_type FROM agent_image_index WHERE agent_id = ? AND image_id = ?")
      .get(agentId, imageId);
    return row ? { mimeType: String(row.mime_type) } : null;
  }

  private async writePrivate(target: string, data: string | Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, data, { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  private agentDir(agentId: string): string {
    if (!AGENT_ID_PATTERN.test(agentId) || agentId === "." || agentId === "..") {
      throw new Error("Invalid agent id");
    }
    return path.join(this.directory, agentId);
  }

  private imagePath(agentId: string, imageId: string, mimeType: string): string {
    return path.join(this.agentDir(agentId), `${imageId}.${EXTENSIONS[mimeType]}`);
  }
}

const PATH_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const INLINE_BASE64_LIMIT = Math.ceil(MAX_AGENT_IMAGE_BYTES / 3) * 4 + 256;

function unavailableRef(
  seed: string,
  mimeType: string | null,
  byteSize: number,
  unavailable: NonNullable<AgentImageRef["unavailable"]>,
  alt: string | undefined,
): AgentImageRef {
  // Nothing is stored for these, so the id only keeps replays of the same source stable.
  return {
    imageId: createHash("sha256").update(seed).digest("hex"),
    mimeType: mimeType ?? "application/octet-stream",
    byteSize,
    unavailable,
    ...(alt ? { alt } : {}),
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function readImageFile(
  filePath: string,
): Promise<{ bytes: Buffer } | { error: "too_large" | "unsupported"; size: number }> {
  if (!PATH_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return { error: "unsupported", size: 0 };
  }
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return { error: "unsupported", size: 0 };
    if (stats.size > MAX_AGENT_IMAGE_BYTES) return { error: "too_large", size: stats.size };
    return { bytes: await fs.readFile(filePath) };
  } catch {
    return { error: "unsupported", size: 0 };
  }
}

function filePathFromSource(source: string): string | null {
  if (source.startsWith("file://")) {
    try {
      return fileURLToPath(source);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(source) ? source : null;
}

function remoteSource(image: ProviderImageOutput): string | null {
  if (nonEmpty(image.data)) return null;
  const source = nonEmpty(image.path) ?? nonEmpty(image.url);
  return source && /^https?:\/\//i.test(source) && source.length <= 4096 ? source : null;
}

/**
 * Stores the image a provider reported and returns the ref a timeline row carries. A path is
 * read only when its extension, size and magic bytes pass; everything else comes back as an
 * `unavailable` ref so the row still says an image existed. An http(s) URL becomes a `remoteUrl`
 * ref and is never stored. This is the only writer of agent output.
 */
export async function storeProviderImage(
  store: AgentImageStore,
  agentId: string,
  image: ProviderImageOutput,
): Promise<AgentImageRef | null> {
  const alt = nonEmpty(image.altText)?.slice(0, 1000) ?? undefined;
  const declaredMime = nonEmpty(image.mimeType);
  // The daemon never fetches remote URLs. The ref carries the URL and the client loads it, so
  // a result that mixes remote and local images keeps them in one grid, in order.
  const remote = remoteSource(image);
  if (remote) {
    return {
      imageId: createHash("sha256").update(remote).digest("hex"),
      mimeType: declaredMime ?? "image/*",
      byteSize: 0,
      remoteUrl: remote,
      ...(alt ? { alt } : {}),
    };
  }
  let data = nonEmpty(image.data);
  const source = nonEmpty(image.path) ?? nonEmpty(image.url);
  if (!data && source?.toLowerCase().startsWith("data:image/")) data = source;
  let bytes: Uint8Array;
  if (data) {
    let mimeType = declaredMime;
    let payload = data;
    if (payload.startsWith("data:")) {
      const separator = payload.indexOf(";base64,");
      if (separator < 0 || separator > 256) {
        return unavailableRef(data.slice(0, 256), declaredMime, 0, "unsupported", alt);
      }
      mimeType = payload.slice(5, separator);
      payload = payload.slice(separator + 8);
    }
    if (payload.length > INLINE_BASE64_LIMIT) {
      return unavailableRef(
        payload,
        mimeType,
        Math.floor((payload.length / 4) * 3),
        "too_large",
        alt,
      );
    }
    bytes = Buffer.from(payload, "base64");
  } else if (source) {
    const filePath = filePathFromSource(source);
    if (!filePath) return unavailableRef(source, declaredMime, 0, "unsupported", alt);
    const result = await readImageFile(filePath);
    if ("error" in result) {
      return unavailableRef(filePath, declaredMime, result.size, result.error, alt);
    }
    bytes = result.bytes;
  } else {
    return null;
  }
  const ref = await store.put(agentId, {
    bytes,
    mimeType: declaredMime ?? "image/png",
    origin: "agent",
  });
  return alt ? { ...ref, alt } : ref;
}
