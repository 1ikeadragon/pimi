import { createCipheriv, randomBytes } from "node:crypto";

export type PushPreviewReason = "finished" | "permission";

const FORMAT_VERSION = 0x01;
const NONCE_BYTES = 12;
const PAD_BLOCK_BYTES = 256;
// pimi-push rejects blobs over 1600 base64url characters; drop the preview rather than truncate.
const MAX_ENC_CHARS = 1600;

interface SealPushPreviewInput {
  /** 32-byte base64url key the phone generated and registered over the session. */
  key: string;
  reason: PushPreviewReason;
  agentId: string;
  title: string;
  body: string;
  ts: number;
}

/**
 * Seals a notification preview for one phone. Format (the Android FCM service opens it):
 * base64url(0x01 || nonce[12] || AES-256-GCM ciphertext || tag[16]), AAD binding the blob to its
 * reason and agent, plaintext JSON padded with spaces to a 256-byte multiple so the length only
 * reveals a coarse bucket. Returns null when the blob would exceed what pimi-push accepts.
 */
export function sealPushPreview(input: SealPushPreviewInput): string | null {
  const json = Buffer.from(JSON.stringify({ ts: input.ts, title: input.title, body: input.body }));
  const padded = Buffer.alloc(Math.ceil(json.length / PAD_BLOCK_BYTES) * PAD_BLOCK_BYTES, 0x20);
  json.copy(padded);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(input.key, "base64url"), nonce);
  cipher.setAAD(Buffer.from(`pimi-push-preview/1|${input.reason}|${input.agentId}`));
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const sealed = Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    nonce,
    ciphertext,
    cipher.getAuthTag(),
  ]);
  const enc = sealed.toString("base64url");
  return enc.length > MAX_ENC_CHARS ? null : enc;
}
