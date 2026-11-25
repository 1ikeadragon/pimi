import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { VaultBitwardenItem } from "@pimi/protocol/vault/types";
import { createExternalProcessEnv } from "../../pimi-env.js";
import { VaultError } from "../errors.js";
import { resolveExecutable } from "../runner.js";

// Reads secrets through the user's own `bw` CLI. The user runs `bw login` themselves; this module
// only unlocks with a master password typed into the Vault page, copies the fields bound to
// vault secrets into memory, and locks `bw` again. It never starts `bw serve` (that endpoint has
// no authentication) and never keeps the session key past one operation. Passkeys are not
// supported: `bw` cannot return them. TOTP codes are not supported either: a code expires in 30
// seconds, so a value cached for minutes would be stale.
//
// NOT VERIFIED against a real `bw`: it was not installed where this was written. Flags follow the
// Bitwarden CLI documentation (`bw unlock --passwordfile --raw`, `--session` via BW_SESSION,
// `bw get item|totp`, `bw list items --search`, `bw lock`). `bw` reads stdin only through a TTY
// prompt, so `--passwordfile` was chosen over `--passwordenv` (an environment variable is visible
// to other same-user processes for as long as `bw` runs; a 0600 file in a 0700 directory is
// removed as soon as `bw unlock` returns).

// How long copied Bitwarden values stay in memory. 15 minutes is Bitwarden's own default vault
// timeout, so a value is never held longer than the vault would stay unlocked there.
export const BITWARDEN_CACHE_TTL_MS = 15 * 60 * 1000;

// One `bw` call. It is a Node program with a one to two second start, and unlock runs the
// account's key derivation (up to a few seconds for Argon2id settings). Thirty seconds leaves
// room for both on a slow machine before the call is treated as hung.
const BW_CALL_TIMEOUT_MS = 30 * 1000;

// `bw list items` returns whole items, passwords included. 16 MiB holds thousands of items; a
// larger vault should narrow the search.
const BW_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const BW_STATUS_SCHEMA = z.object({ status: z.enum(["unauthenticated", "locked", "unlocked"]) });

const BwFieldSchema = z.object({ name: z.string(), value: z.string().nullable() });
const BwItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  login: z
    .object({
      username: z.string().nullable().optional(),
      password: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  fields: z.array(BwFieldSchema).nullable().optional(),
});
type BwItem = z.infer<typeof BwItemSchema>;

export interface BitwardenBinding {
  secretName: string;
  itemId: string;
  field: string;
}

export interface BitwardenAuthState {
  installed: boolean;
  authState: "unauthenticated" | "locked" | "unlocked" | "unknown";
}

export interface BitwardenFetchResult {
  values: Map<string, string>;
  missing: Array<{ secretName: string; reason: "item_not_found" | "field_not_found" }>;
}

function runBw(
  binary: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { env, timeout: BW_CALL_TIMEOUT_MS, maxBuffer: BW_MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) {
          // bw's stderr is not forwarded: it can name accounts and servers, and a client has no
          // use for it. The exit status is enough to choose a message.
          reject(
            new VaultError("source_unavailable", "The Bitwarden CLI call failed.", {
              cause: error,
            }),
          );
          return;
        }
        resolve({ stdout });
      },
    );
    child.stdin?.end();
  });
}

function fieldValue(item: BwItem, field: string): string | null {
  if (field === "password") return item.login?.password ?? null;
  if (field === "username") return item.login?.username ?? null;
  return item.fields?.find((candidate) => candidate.name === field)?.value ?? null;
}

function fieldNames(item: BwItem): string[] {
  const names: string[] = [];
  if (item.login?.password) names.push("password");
  if (item.login?.username) names.push("username");
  for (const field of item.fields ?? []) names.push(field.name);
  return names;
}

export class BitwardenCli {
  constructor(private readonly options: { env: NodeJS.ProcessEnv }) {}

  private async binary(): Promise<string | null> {
    try {
      return await resolveExecutable("bw", {
        cwd: tmpdir(),
        searchPath: this.options.env.PATH ?? "",
      });
    } catch (error) {
      if (error instanceof VaultError && error.code === "invalid_argument") return null;
      throw error;
    }
  }

  private childEnv(session?: string): Record<string, string> {
    return createExternalProcessEnv(this.options.env, {
      BW_NOINTERACTION: "true",
      ...(session ? { BW_SESSION: session } : {}),
    });
  }

  async getAuthState(): Promise<BitwardenAuthState> {
    const binary = await this.binary();
    if (!binary) return { installed: false, authState: "unknown" };
    const { stdout } = await runBw(binary, ["status"], this.childEnv());
    const parsed = BW_STATUS_SCHEMA.safeParse(JSON.parse(stdout));
    return { installed: true, authState: parsed.success ? parsed.data.status : "unknown" };
  }

  /**
   * Unlocks `bw`, runs `work` with the session, and locks `bw` again whatever happens. The master
   * password goes through a private temporary file that is removed before `work` starts.
   */
  private async withSession<T>(
    masterPassword: string,
    work: (binary: string, session: string) => Promise<T>,
  ): Promise<T> {
    const binary = await this.binary();
    if (!binary) {
      throw new VaultError("source_unavailable", "The Bitwarden CLI (bw) is not installed.");
    }
    const directory = await mkdtemp(path.join(tmpdir(), "pimi-bw-"));
    let session: string;
    try {
      const passwordFile = path.join(directory, "password");
      await writeFile(passwordFile, masterPassword, { mode: 0o600 });
      const { stdout } = await runBw(
        binary,
        ["unlock", "--raw", "--passwordfile", passwordFile],
        this.childEnv(),
      );
      session = stdout.trim();
    } catch (error) {
      throw new VaultError(
        "source_unavailable",
        "Bitwarden did not unlock. Check the master password and that you ran `bw login`.",
        { cause: error },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    try {
      return await work(binary, session);
    } finally {
      await runBw(binary, ["lock"], this.childEnv(session));
    }
  }

  /** Item names, ids and field names matching `query`. Values are dropped before returning. */
  async searchItems(masterPassword: string, query: string): Promise<VaultBitwardenItem[]> {
    return this.withSession(masterPassword, async (binary, session) => {
      const { stdout } = await runBw(
        binary,
        ["list", "items", "--search", query],
        this.childEnv(session),
      );
      const items = z.array(BwItemSchema).parse(JSON.parse(stdout));
      return items.map((item) => ({ id: item.id, name: item.name, fields: fieldNames(item) }));
    });
  }

  /** The value of every binding, fetched item by item. */
  async fetch(
    masterPassword: string,
    bindings: readonly BitwardenBinding[],
  ): Promise<BitwardenFetchResult> {
    return this.withSession(masterPassword, async (binary, session) => {
      const result: BitwardenFetchResult = { values: new Map(), missing: [] };
      const items = new Map<string, BwItem | null>();
      for (const binding of bindings) {
        if (!items.has(binding.itemId)) {
          items.set(binding.itemId, await this.getItem(binary, session, binding.itemId));
        }
        const item = items.get(binding.itemId) ?? null;
        if (!item) {
          result.missing.push({ secretName: binding.secretName, reason: "item_not_found" });
          continue;
        }
        const value = fieldValue(item, binding.field);
        if (value === null || value.length === 0) {
          result.missing.push({ secretName: binding.secretName, reason: "field_not_found" });
          continue;
        }
        result.values.set(binding.secretName, value);
      }
      return result;
    });
  }

  /** Null when `bw` cannot return the item (deleted, wrong id, or a failed call); callers report it as missing. */
  private async getItem(binary: string, session: string, id: string): Promise<BwItem | null> {
    try {
      const { stdout } = await runBw(binary, ["get", "item", id], this.childEnv(session));
      return BwItemSchema.parse(JSON.parse(stdout));
    } catch (error) {
      if (error instanceof VaultError) return null;
      throw error;
    }
  }
}
