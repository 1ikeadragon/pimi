import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { VaultError } from "./errors.js";

// Passphrase-sealed storage: key = scrypt(passphrase, salt), payload = one AES-256-GCM message.
// Only node:crypto. The key lives in daemon memory while unlocked and nowhere else.

export const VAULT_FORMAT_VERSION = 1;

// ---

// scrypt cost. OWASP's password storage cheat sheet lists N=2^17, r=8, p=1 as a minimum
// configuration (128 MiB of memory, about 0.3-0.8 s on an Apple M1, measured on this repo's
// development machine). Unlock is a rare, human-initiated operation, so the cost is acceptable;
// it is also the price an offline attacker with a copy of vault.json pays per passphrase guess.
export const SCRYPT_N = 2 ** 17;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;

// Highest N a vault file may ask for. A file we did not write must not make the daemon allocate
// without bound. 2^18 is double what we write (256 MiB), leaving room to raise the cost later.
export const SCRYPT_MAX_N = 2 ** 18;

// scrypt needs 128 * N * r bytes for its V array plus 128 * r * p for its working blocks. Node's
// default maxmem is 32 MiB, which rejects N=2^17, r=8 with ERR_CRYPTO_INVALID_SCRYPT_PARAMS
// ("memory limit exceeded", reproduced on node 22). Headroom covers OpenSSL's own bookkeeping.
const SCRYPT_MAXMEM_HEADROOM_BYTES = 8 * 1024 * 1024;

// AES-256 key.
export const KEY_BYTES = 32;

// 128-bit salt: NIST SP 800-132 asks for at least 128 bits, and a random salt of that size does
// not repeat across vaults.
export const SALT_BYTES = 16;

// GCM's recommended 96-bit nonce, drawn at random for every write. With a fixed key the
// collision bound is about 2^32 writes; the vault is written by hand-driven operations, orders of
// magnitude below that, and the key changes whenever the vault is re-created.
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

// ---

export interface KdfParams {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
}

/** The unencrypted fields of the file. All of them are bound to the ciphertext as AAD. */
export interface VaultHeader {
  version: number;
  kdf: KdfParams;
  /** Environment variable names removed from the environment of everything the daemon launches. */
  envScrubNames: string[];
}

export interface SealedPayload {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export function newKdfParams(): KdfParams {
  return { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: randomBytes(SALT_BYTES) };
}

/** Rejects parameters from a file that differ from what this build writes or could be a DoS. */
export function assertAcceptableKdfParams(kdf: KdfParams): void {
  const powerOfTwo = Number.isInteger(Math.log2(kdf.N));
  const inRange = kdf.N >= SCRYPT_N && kdf.N <= SCRYPT_MAX_N;
  if (!powerOfTwo || !inRange || kdf.r !== SCRYPT_R || kdf.p !== SCRYPT_P) {
    throw new VaultError(
      "corrupt",
      "The vault file uses key derivation settings Pimi did not write.",
    );
  }
  if (kdf.salt.length !== SALT_BYTES) {
    throw new VaultError("corrupt", "The vault file has a malformed salt.");
  }
}

function scryptAsync(secret: Buffer, kdf: KdfParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 128 * kdf.N * kdf.r + 128 * kdf.r * kdf.p + SCRYPT_MAXMEM_HEADROOM_BYTES,
  };
  return new Promise((resolve, reject) => {
    scrypt(secret, kdf.salt, KEY_BYTES, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** NFKC so the same typed passphrase derives the same key on every platform's input method. */
export async function deriveVaultKey(passphrase: string, kdf: KdfParams): Promise<Buffer> {
  assertAcceptableKdfParams(kdf);
  const secret = Buffer.from(passphrase.normalize("NFKC"), "utf8");
  try {
    return await scryptAsync(secret, kdf);
  } finally {
    secret.fill(0);
  }
}

/**
 * The AAD is the header serialized in a fixed field order, so editing the salt, cost or scrub list
 * on disk fails authentication instead of silently changing behavior.
 */
export function headerAad(header: VaultHeader): Buffer {
  return Buffer.from(
    JSON.stringify([
      header.version,
      header.kdf.N,
      header.kdf.r,
      header.kdf.p,
      header.kdf.salt.toString("base64"),
      header.envScrubNames,
    ]),
    "utf8",
  );
}

export function sealPayload(params: {
  key: Buffer;
  header: VaultHeader;
  plaintext: Buffer;
}): SealedPayload {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", params.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(headerAad(params.header));
  const ciphertext = Buffer.concat([cipher.update(params.plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** Throws `bad_passphrase` when the tag does not verify: wrong key or a modified file. */
export function openPayload(params: {
  key: Buffer;
  header: VaultHeader;
  sealed: SealedPayload;
}): Buffer {
  const { key, header, sealed } = params;
  if (sealed.nonce.length !== NONCE_BYTES || sealed.tag.length !== TAG_BYTES) {
    throw new VaultError("corrupt", "The vault file has a malformed nonce or tag.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(headerAad(header));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch (error) {
    throw new VaultError("bad_passphrase", "Wrong passphrase, or the vault file was modified.", {
      cause: error,
    });
  }
}

/** Constant-time comparison of two derived keys. */
export function keysEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
