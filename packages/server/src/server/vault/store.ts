import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  VaultEnvNameSchema,
  VaultGrantSchema,
  VaultSecretSourceSchema,
  VaultSecretNameSchema,
} from "@pimi/protocol/vault/types";
import { writePrivateFileAtomic } from "../private-files.js";
import {
  VAULT_FORMAT_VERSION,
  type KdfParams,
  type SealedPayload,
  type VaultHeader,
} from "./crypto.js";
import { VaultError } from "./errors.js";

// $PIMI_HOME/vault/vault.json, mode 0600, one ciphertext. The header (KDF cost, salt, scrub
// names) is readable without the passphrase: the daemon must know which environment variables to
// remove before anything is unlocked. The scrub names are therefore not secret; the values are.

export const VAULT_DIRECTORY_NAME = "vault";
export const VAULT_FILE_NAME = "vault.json";

const VaultFileSchema = z.object({
  version: z.literal(VAULT_FORMAT_VERSION),
  kdf: z.object({
    name: z.literal("scrypt"),
    N: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
    salt: z.string(),
  }),
  envScrubNames: z.array(VaultEnvNameSchema),
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});

export const VaultSecretRecordSchema = z.object({
  name: VaultSecretNameSchema,
  envName: VaultEnvNameSchema,
  description: z.string().nullable(),
  source: VaultSecretSourceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** Local secrets only. Bitwarden secrets are fetched into memory on unlock and never stored. */
  value: z.string().nullable(),
});
export type VaultSecretRecord = z.infer<typeof VaultSecretRecordSchema>;

export const VaultGrantRecordSchema = VaultGrantSchema.omit({ runsProjectCode: true });
export type VaultGrantRecord = z.infer<typeof VaultGrantRecordSchema>;

export const VaultPayloadSchema = z.object({
  secrets: z.array(VaultSecretRecordSchema),
  grants: z.array(VaultGrantRecordSchema),
  /** Names the user removes from agents' environment without storing a value here. */
  scrubOnly: z.array(VaultEnvNameSchema),
});
export type VaultPayload = z.infer<typeof VaultPayloadSchema>;

export interface StoredVault {
  header: VaultHeader;
  sealed: SealedPayload;
}

export function vaultDirectory(pimiHome: string): string {
  return path.join(pimiHome, VAULT_DIRECTORY_NAME);
}

function vaultFilePath(pimiHome: string): string {
  return path.join(vaultDirectory(pimiHome), VAULT_FILE_NAME);
}

function parseVaultFile(raw: string): StoredVault {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new VaultError("corrupt", "The vault file is not valid JSON.", { cause: error });
  }
  const parsed = VaultFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new VaultError("corrupt", "The vault file does not have the expected shape.", {
      cause: parsed.error,
    });
  }
  const file = parsed.data;
  const kdf: KdfParams = {
    N: file.kdf.N,
    r: file.kdf.r,
    p: file.kdf.p,
    salt: Buffer.from(file.kdf.salt, "base64"),
  };
  return {
    header: { version: file.version, kdf, envScrubNames: file.envScrubNames },
    sealed: {
      nonce: Buffer.from(file.nonce, "base64"),
      ciphertext: Buffer.from(file.ciphertext, "base64"),
      tag: Buffer.from(file.tag, "base64"),
    },
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * The unauthenticated header, read before any unlock: the daemon must know which environment
 * variables to remove before it starts anything that could spawn a process. Null when no vault
 * exists.
 */
export async function readVaultHeader(pimiHome: string): Promise<VaultHeader | null> {
  let raw: string;
  try {
    raw = await readFile(vaultFilePath(pimiHome), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  return parseVaultFile(raw).header;
}

export class VaultStore {
  constructor(private readonly pimiHome: string) {}

  /** Null when no vault was ever created. */
  async load(): Promise<StoredVault | null> {
    let raw: string;
    try {
      raw = await readFile(vaultFilePath(this.pimiHome), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    return parseVaultFile(raw);
  }

  async save(stored: StoredVault): Promise<void> {
    const { header, sealed } = stored;
    const file: z.infer<typeof VaultFileSchema> = {
      version: VAULT_FORMAT_VERSION,
      kdf: {
        name: "scrypt",
        N: header.kdf.N,
        r: header.kdf.r,
        p: header.kdf.p,
        salt: header.kdf.salt.toString("base64"),
      },
      envScrubNames: header.envScrubNames,
      nonce: sealed.nonce.toString("base64"),
      ciphertext: sealed.ciphertext.toString("base64"),
      tag: sealed.tag.toString("base64"),
    };
    await writePrivateFileAtomic(vaultFilePath(this.pimiHome), JSON.stringify(file));
  }
}
