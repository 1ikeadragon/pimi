/**
 * The filesystem surface instruction discovery reads through. Resolvers take it as an argument
 * so a scratch script can point them at a fixture tree, and so every read is bounded in one place.
 */
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

export type InstructionFsFailure = "missing" | "denied" | "other";

export type InstructionFsResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: InstructionFsFailure; message: string };

export interface InstructionStat {
  kind: "file" | "directory" | "other";
  size: number;
}

export interface InstructionDirEntry {
  name: string;
  /** Follows symlinks, so a link to a directory reads as a directory. */
  kind: "file" | "directory" | "other";
}

export interface InstructionHead {
  bytes: Buffer;
  /** The file's whole size; larger than `bytes` when the read was cut. */
  size: number;
}

export interface InstructionFs {
  /** Follows symlinks. */
  stat(path: string): Promise<InstructionFsResult<InstructionStat>>;
  /** Does not follow: reports whether `path` itself is a symlink. */
  isSymlink(path: string): Promise<InstructionFsResult<boolean>>;
  realpath(path: string): Promise<InstructionFsResult<string>>;
  readHead(path: string, maxBytes: number): Promise<InstructionFsResult<InstructionHead>>;
  readDirectory(path: string): Promise<InstructionFsResult<InstructionDirEntry[]>>;
}

function failure(error: unknown): { ok: false; failure: InstructionFsFailure; message: string } {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, failure: "missing", message };
  if (code === "EACCES" || code === "EPERM") return { ok: false, failure: "denied", message };
  return { ok: false, failure: "other", message };
}

function kindOf(info: {
  isFile(): boolean;
  isDirectory(): boolean;
}): "file" | "directory" | "other" {
  if (info.isFile()) return "file";
  return info.isDirectory() ? "directory" : "other";
}

export const nodeInstructionFs: InstructionFs = {
  async stat(path) {
    try {
      const info = await stat(path);
      return { ok: true, value: { kind: kindOf(info), size: info.size } };
    } catch (error) {
      return failure(error);
    }
  },
  async isSymlink(path) {
    try {
      return { ok: true, value: (await lstat(path)).isSymbolicLink() };
    } catch (error) {
      return failure(error);
    }
  },
  async realpath(path) {
    try {
      return { ok: true, value: await realpath(path) };
    } catch (error) {
      return failure(error);
    }
  },
  async readHead(path, maxBytes) {
    try {
      const handle = await open(path, "r");
      try {
        const { size } = await handle.stat();
        const length = Math.min(size, maxBytes);
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await handle.read(bytes, 0, length, 0);
        return { ok: true, value: { bytes: bytes.subarray(0, bytesRead), size } };
      } finally {
        await handle.close();
      }
    } catch (error) {
      return failure(error);
    }
  },
  async readDirectory(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const resolved: InstructionDirEntry[] = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          // A dangling link has no kind; it lists as "other" and the layer builder reports it.
          const target = await stat(join(path, entry.name)).catch(() => null);
          resolved.push({ name: entry.name, kind: target ? kindOf(target) : "other" });
        } else {
          resolved.push({ name: entry.name, kind: kindOf(entry) });
        }
      }
      return { ok: true, value: resolved };
    } catch (error) {
      return failure(error);
    }
  },
};
