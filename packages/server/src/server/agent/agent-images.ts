import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

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

export interface AgentImageRef {
  imageId: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  alt?: string;
  unavailable?: "too_large" | "unsupported";
}

export function isSupportedImageMimeType(mimeType: string): boolean {
  return mimeType in EXTENSIONS;
}

export function agentImageId(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface AgentImageStore {
  put(
    agentId: string,
    input: { bytes: Uint8Array; mimeType: string; origin: AgentImageOrigin },
  ): Promise<AgentImageRef>;
  read(agentId: string, imageId: string): Promise<{ mimeType: string; bytes: Buffer } | null>;
  delete(agentId: string): Promise<void>;
}

const INDEX_SCHEMA = z.object({
  version: z.literal(1),
  images: z.record(
    z.string(),
    z.object({ mimeType: z.string(), origin: z.enum(["user", "agent"]) }),
  ),
});
type ImageIndex = z.infer<typeof INDEX_SCHEMA>["images"];

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class FileAgentImageStore implements AgentImageStore {
  private readonly logger: Logger;
  private readonly indexes = new Map<string, ImageIndex>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly directory: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "agent", component: "agent-images" });
  }

  async put(
    agentId: string,
    input: { bytes: Uint8Array; mimeType: string; origin: AgentImageOrigin },
  ): Promise<AgentImageRef> {
    const imageId = agentImageId(input.bytes);
    const base = { imageId, mimeType: input.mimeType, byteSize: input.bytes.length };
    if (!isSupportedImageMimeType(input.mimeType)) return { ...base, unavailable: "unsupported" };
    if (input.bytes.length > MAX_AGENT_IMAGE_BYTES) return { ...base, unavailable: "too_large" };
    await this.enqueue(agentId, async () => {
      const index = await this.loadIndex(agentId);
      if (index[imageId]) return;
      await this.writePrivate(this.imagePath(agentId, imageId, input.mimeType), input.bytes);
      index[imageId] = { mimeType: input.mimeType, origin: input.origin };
      await this.writePrivate(
        this.indexPath(agentId),
        JSON.stringify({ version: 1, images: index }),
      );
    });
    return base;
  }

  async read(
    agentId: string,
    imageId: string,
  ): Promise<{ mimeType: string; bytes: Buffer } | null> {
    // The id only selects an index entry; the path and mime type come from the daemon.
    if (!IMAGE_ID_PATTERN.test(imageId)) return null;
    const entry = await this.enqueue(agentId, async () => (await this.loadIndex(agentId))[imageId]);
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
      this.indexes.delete(agentId);
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

  private async loadIndex(agentId: string): Promise<ImageIndex> {
    const cached = this.indexes.get(agentId);
    if (cached) return cached;
    let images: ImageIndex = {};
    try {
      const parsed = INDEX_SCHEMA.safeParse(
        JSON.parse(await fs.readFile(this.indexPath(agentId), "utf8")),
      );
      if (parsed.success) images = parsed.data.images;
      else this.logger.error({ agentId }, "Invalid agent image index");
    } catch (error) {
      if (!isMissingFile(error))
        this.logger.error({ err: error, agentId }, "Failed to read image index");
    }
    this.indexes.set(agentId, images);
    return images;
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

  private indexPath(agentId: string): string {
    return path.join(this.agentDir(agentId), "index.json");
  }

  private imagePath(agentId: string, imageId: string, mimeType: string): string {
    return path.join(this.agentDir(agentId), `${imageId}.${EXTENSIONS[mimeType]}`);
  }
}
