import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateFileAsync, writePrivateFileAtomic } from "./private-files.js";

const TOKEN_FILENAME = "relay-server-token";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The daemon's relay registration token: 256 random bits the relay binds to this
 * serverId on first use, so nobody else can register as this daemon and evict it.
 * Independent of the E2EE key, so a pairing reset leaves the relay binding intact.
 * Never shown to clients or put in a pairing offer.
 */
export async function loadOrCreateRelayServerToken(pimiHome: string): Promise<string> {
  const filePath = path.join(pimiHome, TOKEN_FILENAME);
  const existing = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    await ensurePrivateFileAsync(filePath);
    const token = existing.trim();
    if (TOKEN_PATTERN.test(token)) return token;
    // A malformed token was never accepted by a relay; replacing it loses nothing.
  }
  const token = randomBytes(32).toString("base64url");
  await writePrivateFileAtomic(filePath, `${token}\n`);
  return token;
}
