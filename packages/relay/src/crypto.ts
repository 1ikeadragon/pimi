/**
 * E2EE crypto primitives, byte-compatible with NaCl crypto_box.
 *
 * - Key exchange: X25519, then HSalsa20 with a zero nonce (crypto_box_beforenm)
 * - Encryption: XSalsa20-Poly1305 (crypto_secretbox: 16-byte tag, then ciphertext)
 *
 * Bundle format (binary):
 *   [nonce (24 bytes)] [ciphertext...]
 *
 * The encrypted channel chooses the WebSocket representation. Crypto remains
 * byte-oriented so frame kind is never inferred from plaintext contents.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { randomBytes, u32, utf8ToBytes } from "@noble/ciphers/utils.js";
import { fromByteArray, toByteArray } from "base64-js";

export interface KeyPair {
  publicKey: Uint8Array; // 32 bytes
  secretKey: Uint8Array; // 32 bytes
}

export type SharedKey = Uint8Array; // 32 bytes (box.before)

const KEY_LENGTH = 32;
const NONCE_LENGTH = 24;
// hsalsa reads native-endian word views of these bytes, as noble's own xsalsa20 does.
const SIGMA = u32(utf8ToBytes("expand 32-byte k"));

function encodeBase64(bytes: Uint8Array): string {
  return fromByteArray(bytes);
}

function decodeBase64(base64: string): Uint8Array {
  return toByteArray(base64);
}

function decodePublicKeyBase64(base64: string): Uint8Array {
  if (
    typeof base64 !== "string" ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  ) {
    throw new Error("Invalid public key encoding");
  }

  const bytes = decodeBase64(base64);
  if (encodeBase64(bytes) !== base64) {
    throw new Error("Invalid public key encoding");
  }
  return bytes;
}

function toUint8(data: string | ArrayBuffer): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

export function generateKeyPair(): KeyPair {
  const secretKey = randomBytes(KEY_LENGTH);
  return { publicKey: x25519.getPublicKey(secretKey), secretKey };
}

export function exportPublicKey(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== KEY_LENGTH) {
    throw new Error(`Invalid public key length (expected ${KEY_LENGTH})`);
  }
  return encodeBase64(publicKey);
}

export function importPublicKey(base64: string): Uint8Array {
  const bytes = decodePublicKeyBase64(base64);
  if (bytes.byteLength !== KEY_LENGTH) {
    throw new Error(`Invalid public key length (expected ${KEY_LENGTH})`);
  }
  return bytes;
}

export function exportSecretKey(secretKey: Uint8Array): string {
  if (!(secretKey instanceof Uint8Array) || secretKey.byteLength !== KEY_LENGTH) {
    throw new Error(`Invalid secret key length (expected ${KEY_LENGTH})`);
  }
  return encodeBase64(secretKey);
}

export function importSecretKey(base64: string): Uint8Array {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength !== KEY_LENGTH) {
    throw new Error(`Invalid secret key length (expected ${KEY_LENGTH})`);
  }
  return bytes;
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): SharedKey {
  if (ourSecretKey.byteLength !== KEY_LENGTH) {
    throw new Error(`Invalid secret key length (expected ${KEY_LENGTH})`);
  }
  if (peerPublicKey.byteLength !== KEY_LENGTH) {
    throw new Error(`Invalid peer public key length (expected ${KEY_LENGTH})`);
  }

  let rawSharedResult: Uint8Array;
  try {
    // Throws on low-order points and an all-zero result.
    rawSharedResult = x25519.getSharedSecret(ourSecretKey, peerPublicKey);
  } catch {
    throw new Error("Invalid peer public key");
  }
  const sharedKey = new Uint8Array(KEY_LENGTH);
  hsalsa(SIGMA, u32(rawSharedResult), new Uint32Array(4), u32(sharedKey));
  rawSharedResult.fill(0);
  return sharedKey;
}

/**
 * Encrypts data and returns the binary bundle:
 *   [nonce (24)] [ciphertext...]
 */
export function encrypt(sharedKey: SharedKey, data: string | ArrayBuffer): ArrayBuffer {
  const nonce = randomBytes(NONCE_LENGTH);
  const plaintext = toUint8(data);
  const ciphertext = xsalsa20poly1305(sharedKey, nonce).encrypt(plaintext);
  const out = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.byteLength);
  return toArrayBuffer(out);
}

export function decrypt(sharedKey: SharedKey, data: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(data);
  if (bytes.byteLength < NONCE_LENGTH) {
    throw new Error("Ciphertext bundle too short");
  }

  const nonce = bytes.slice(0, NONCE_LENGTH);
  const ciphertext = bytes.slice(NONCE_LENGTH);
  let opened: Uint8Array;
  try {
    opened = xsalsa20poly1305(sharedKey, nonce).decrypt(ciphertext);
  } catch {
    throw new Error("Decryption failed");
  }

  return toArrayBuffer(opened);
}
