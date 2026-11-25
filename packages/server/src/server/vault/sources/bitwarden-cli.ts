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
// only unlocks with a master password typed into Pimi, syncs, lists the items once to build a
// value-free index and to copy the fields bound to vault secrets, and locks `bw` again. It never
// starts `bw serve` (that endpoint has no authentication) and never keeps the session key past
// one operation. Passkeys are not supported: `bw` cannot return them. TOTP codes are not
// supported either: a code expires in 30 seconds, so a value cached for minutes would be stale.
//
// Run against `bw` 2026.11.1: `bw status` prints JSON and exits 0 even when signed out; failures
// of every other command print their message on stdout and exit 1. Not run against an account
// (none was available): `unlock`, `sync` and `list items` output with a logged-in CLI follows the
// Bitwarden documentation. `bw` reads stdin only through a TTY prompt, so `--passwordfile` was
// chosen over `--passwordenv` (an environment variable is visible to other same-user processes
// for as long as `bw` runs; a 0600 file in a 0700 directory is removed as soon as `bw unlock`
// returns).

// How long copied Bitwarden values and the index stay in memory. 15 minutes is Bitwarden's own
// default vault timeout, so a value is never held longer than the vault would stay unlocked there.
export const BITWARDEN_CACHE_TTL_MS = 15 * 60 * 1000;

// One `bw` call. It is a Node program with a one to two second start, and unlock runs the
// account's key derivation (up to a few seconds for Argon2id settings); sync needs the network.
// Thirty seconds leaves room for these on a slow machine before the call is treated as hung.
const BW_CALL_TIMEOUT_MS = 30 * 1000;

// How long `bw status` is trusted. A page change asks for it several times; the answer only
// changes when the user logs in or out in a terminal, and the Check again button forces a re-read.
const STATUS_CACHE_MS = 10 * 1000;

// `bw list items` returns whole items, passwords included. 16 MiB holds thousands of items.
const BW_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const BwStatusSchema = z.object({
  status: z.enum(["unauthenticated", "locked", "unlocked"]),
  serverUrl: z.string().nullable().optional(),
  lastSync: z.string().nullable().optional(),
  userEmail: z.string().nullable().optional(),
});

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

export interface BitwardenAccount {
  installed: boolean;
  binaryPath: string | null;
  authState: "unauthenticated" | "locked" | "unlocked" | "unknown";
  userEmail: string | null;
  serverUrl: string | null;
  lastSyncAt: string | null;
}

export interface BitwardenOpenResult {
  /** Names and usernames only. */
  items: VaultBitwardenItem[];
  values: Map<string, string>;
  missing: Array<{ secretName: string; reason: "item_not_found" | "field_not_found" }>;
  /** False when `bw sync` failed and the listing came from the CLI's local copy. */
  synced: boolean;
}

interface BwCallFailure {
  timedOut: boolean;
  tooLarge: boolean;
}

class BwCallError extends VaultError {
  constructor(
    readonly failure: BwCallFailure,
    cause: unknown,
  ) {
    super("source_unavailable", "The Bitwarden CLI call failed.", { cause });
  }
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
          // bw's output is not forwarded: it can name accounts and servers, and the exit status
          // plus these two facts are enough to choose a message.
          const code = (error as NodeJS.ErrnoException).code;
          reject(
            new BwCallError(
              {
                timedOut: "killed" in error && error.killed === true,
                tooLarge: code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
              },
              error,
            ),
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

function describeCallFailure(error: unknown, fallback: string): VaultError {
  if (error instanceof BwCallError && error.failure.timedOut) {
    return new VaultError(
      "source_unavailable",
      "Bitwarden did not answer. Check the network and try again.",
      { cause: error },
    );
  }
  if (error instanceof BwCallError && error.failure.tooLarge) {
    return new VaultError(
      "source_unavailable",
      "Your Bitwarden vault is too large to list. Bind items by id.",
      { cause: error },
    );
  }
  return new VaultError("source_unavailable", fallback, { cause: error });
}

export class BitwardenCli {
  private cachedAccount: { account: BitwardenAccount; at: number } | null = null;

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

  /** What `bw status` says, answered from a 10 s cache unless `fresh`. */
  async account(options: { fresh: boolean }): Promise<BitwardenAccount> {
    const cached = this.cachedAccount;
    if (!options.fresh && cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.account;
    const account = await this.readAccount();
    this.cachedAccount = { account, at: Date.now() };
    return account;
  }

  private async readAccount(): Promise<BitwardenAccount> {
    const binary = await this.binary();
    if (!binary) {
      return {
        installed: false,
        binaryPath: null,
        authState: "unknown",
        userEmail: null,
        serverUrl: null,
        lastSyncAt: null,
      };
    }
    let stdout: string;
    try {
      ({ stdout } = await runBw(binary, ["status"], this.childEnv()));
    } catch (error) {
      throw describeCallFailure(error, "Bitwarden did not report its status.");
    }
    const parsed = BwStatusSchema.safeParse(JSON.parse(stdout));
    return {
      installed: true,
      binaryPath: binary,
      authState: parsed.success ? parsed.data.status : "unknown",
      userEmail: parsed.success ? (parsed.data.userEmail ?? null) : null,
      serverUrl: parsed.success ? (parsed.data.serverUrl ?? null) : null,
      lastSyncAt: parsed.success ? (parsed.data.lastSync ?? null) : null,
    };
  }

  /**
   * Unlocks `bw`, runs `work` with the session, and locks `bw` again whatever happens. The master
   * password goes through a private temporary file that is removed before `work` starts.
   */
  private async withSession<T>(
    masterPassword: string,
    work: (binary: string, session: string) => Promise<T>,
  ): Promise<T> {
    const account = await this.account({ fresh: true });
    if (!account.installed || account.binaryPath === null) {
      throw new VaultError("source_unavailable", "The Bitwarden CLI (bw) is not installed.");
    }
    if (account.authState === "unauthenticated") {
      throw new VaultError(
        "source_unavailable",
        "Bitwarden is signed out. Run `bw login` in a terminal first.",
      );
    }
    const binary = account.binaryPath;
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
      throw describeCallFailure(error, "Bitwarden did not unlock. Check the master password.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    try {
      return await work(binary, session);
    } finally {
      await runBw(binary, ["lock"], this.childEnv(session)).catch((error: unknown) => {
        if (!(error instanceof BwCallError)) throw error;
      });
      this.cachedAccount = null;
    }
  }

  /**
   * One master password entry: unlock, sync, list every item once, keep the value-free index and
   * the bound fields, drop the rest, lock. A failed sync is not fatal.
   */
  async open(
    masterPassword: string,
    bindings: readonly BitwardenBinding[],
  ): Promise<BitwardenOpenResult> {
    return this.withSession(masterPassword, async (binary, session) => {
      const env = this.childEnv(session);
      let synced = true;
      try {
        await runBw(binary, ["sync"], env);
      } catch (error) {
        if (!(error instanceof BwCallError)) throw error;
        synced = false;
      }
      let stdout: string;
      try {
        ({ stdout } = await runBw(binary, ["list", "items"], env));
      } catch (error) {
        throw describeCallFailure(error, "Bitwarden did not list its items.");
      }
      const listed = z.array(BwItemSchema).parse(JSON.parse(stdout));
      const byId = new Map(listed.map((item) => [item.id, item]));
      const result: BitwardenOpenResult = {
        items: listed.map((item) => ({
          id: item.id,
          name: item.name,
          username: item.login?.username ?? null,
          fields: fieldNames(item),
        })),
        values: new Map(),
        missing: [],
        synced,
      };
      for (const binding of bindings) {
        const item = byId.get(binding.itemId);
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
}
