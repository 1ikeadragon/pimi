import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import type { VaultQuickUnlock } from "@pimi/protocol/vault/types";
import { writePrivateFileAtomic } from "../private-files.js";
import { VaultError } from "./errors.js";
import { VAULT_DIRECTORY_NAME } from "./store.js";

// Touch ID unlock. The helper (packages/desktop/native/mac-vault) wraps the vault key under a
// Secure Enclave key that needs user presence on every use, and the wrapped blob is all this file
// stores. The key never goes into argv or the environment: it passes over stdin, and comes back
// on stdout of `unwrap` only.

export const QUICK_UNLOCK_FILE_NAME = "quick-unlock.json";

// A Touch ID prompt that nobody answers must not hold the daemon's caller forever.
const UNWRAP_TIMEOUT_MS = 60 * 1000;
const WRAP_TIMEOUT_MS = 15 * 1000;

const EXIT_CANCELLED = 2;
const EXIT_KEY_GONE = 3;

const PURPOSE_REASON = {
  unlock: "unlock the Pimi vault",
  authorize: "approve a Pimi vault change",
} as const;
export type QuickUnlockPurpose = keyof typeof PURPOSE_REASON;

const AvailabilitySchema = z.object({ secureEnclave: z.boolean(), biometry: z.boolean() });

const WrappedKeySchema = z.object({
  version: z.literal(1),
  seKey: z.string().min(1),
  ephemeralPublicKey: z.string().min(1),
  sealed: z.string().min(1),
});

const EnrollmentSchema = z.object({
  version: z.literal(1),
  /** The vault's KDF salt (base64) the key was wrapped for. A different salt means a different vault. */
  kdfSalt: z.string().min(1),
  wrapped: WrappedKeySchema,
});
type Enrollment = z.infer<typeof EnrollmentSchema>;

const HEX_KEY = /^[0-9a-f]{64}$/;

interface HelperResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface QuickUnlockOptions {
  pimiHome: string;
  /** Path of `pimi-vault-key`; null on hosts that cannot offer Touch ID. */
  helperPath: string | null;
  logger: pino.Logger;
}

export class QuickUnlock {
  private readonly helperPath: string | null;
  private readonly file: string;
  private readonly logger: pino.Logger;
  private secureEnclave = false;
  private enrollment: Enrollment | null = null;
  private promptOpen = false;

  constructor(options: QuickUnlockOptions) {
    this.helperPath = options.helperPath;
    this.file = path.join(options.pimiHome, VAULT_DIRECTORY_NAME, QUICK_UNLOCK_FILE_NAME);
    this.logger = options.logger.child({ module: "vault-quick-unlock" });
  }

  /** Probes the helper once and reads the enrollment file. Call after the vault header is loaded. */
  async init(): Promise<void> {
    if (!this.helperPath) return;
    const probe = await this.run(["available"], null, WRAP_TIMEOUT_MS);
    if (probe.code !== 0) {
      this.logger.warn({ code: probe.code }, "The Touch ID helper did not answer");
      return;
    }
    this.secureEnclave = AvailabilitySchema.parse(JSON.parse(probe.stdout)).secureEnclave;
    this.enrollment = await this.readEnrollment();
  }

  /** `on` only counts for the vault the key was wrapped for; the caller deletes a stale file through `unwrapKey`. */
  availability(kdfSalt: string | null = null): VaultQuickUnlock {
    if (!this.secureEnclave) return "unavailable";
    if (!this.enrollment) return "off";
    return kdfSalt === null || this.enrollment.kdfSalt === kdfSalt ? "on" : "off";
  }

  async enable(key: Buffer, kdfSalt: string): Promise<void> {
    this.requireAvailable();
    const hex = key.toString("hex");
    const result = await this.run(["wrap"], hex, WRAP_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new VaultError("source_unavailable", "Touch ID could not be set up on this Mac.");
    }
    const wrapped = WrappedKeySchema.parse(JSON.parse(result.stdout));
    const enrollment: Enrollment = { version: 1, kdfSalt, wrapped };
    const serialized = JSON.stringify(enrollment);
    if (serialized.includes(hex)) {
      throw new VaultError("corrupt", "The Touch ID enrollment would contain the vault key.");
    }
    await writePrivateFileAtomic(this.file, serialized);
    this.enrollment = enrollment;
  }

  /** Prompts the user and returns the vault key. The caller zeroes the buffer. */
  async unwrapKey(purpose: QuickUnlockPurpose, kdfSalt: string): Promise<Buffer> {
    this.requireAvailable();
    const enrollment = this.enrollment;
    if (!enrollment) throw new VaultError("key_gone", "Touch ID unlock is not set up.");
    if (enrollment.kdfSalt !== kdfSalt) {
      await this.disable();
      throw new VaultError("key_gone", "Touch ID unlock needs to be set up again.");
    }
    if (this.promptOpen) {
      throw new VaultError("prompt_open", "A Touch ID prompt is already open on the Mac.");
    }
    this.promptOpen = true;
    try {
      const result = await this.run(
        ["unwrap", "--reason", PURPOSE_REASON[purpose]],
        JSON.stringify(enrollment.wrapped),
        UNWRAP_TIMEOUT_MS,
      );
      return await this.keyFromResult(result);
    } finally {
      this.promptOpen = false;
    }
  }

  async disable(): Promise<void> {
    this.enrollment = null;
    await rm(this.file, { force: true });
  }

  private async keyFromResult(result: HelperResult): Promise<Buffer> {
    if (result.code === EXIT_CANCELLED) {
      throw new VaultError("cancelled", "Touch ID was cancelled.");
    }
    if (result.code === EXIT_KEY_GONE) {
      await this.disable();
      throw new VaultError("key_gone", "Touch ID unlock needs to be set up again.");
    }
    const hex = result.stdout.trim();
    if (result.code !== 0 || !HEX_KEY.test(hex)) {
      this.logger.warn({ code: result.code }, "The Touch ID helper failed");
      throw new VaultError("source_unavailable", "Touch ID did not answer.");
    }
    return Buffer.from(hex, "hex");
  }

  private requireAvailable(): void {
    if (!this.secureEnclave) {
      throw new VaultError("source_unavailable", "Touch ID is not available on this host.");
    }
  }

  private async readEnrollment(): Promise<Enrollment | null> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = EnrollmentSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      await rm(this.file, { force: true });
      return null;
    }
    return parsed.data;
  }

  private run(args: string[], stdin: string | null, timeoutMs: number): Promise<HelperResult> {
    const helper = this.helperPath;
    if (!helper) throw new VaultError("source_unavailable", "Touch ID is not available.");
    return new Promise((resolve, reject) => {
      const child = spawn(helper, args, {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutMs,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(stdin ?? "");
    });
  }
}
