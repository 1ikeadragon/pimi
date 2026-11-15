/**
 * X25519 static key handling for the daemon's relay identity: generation and
 * strict base64 import/export. The channel itself is Noise (see noise/ and
 * secure-channel.ts).
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { fromByteArray, toByteArray } from "base64-js";

export interface KeyPair {
  publicKey: Uint8Array; // 32 bytes
  secretKey: Uint8Array; // 32 bytes
}

const KEY_LENGTH = 32;

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
