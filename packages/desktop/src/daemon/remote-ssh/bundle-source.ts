import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { RemoteSshError } from "./errors.js";
import { remoteBundleAssetName, type RemoteBundleArch } from "./bundle-spec.js";

const RELEASES_URL = "https://github.com/1ikeadragon/pimi-releases/releases/download";
// pimi-all-v tags build every platform; pimi-v tags are macOS-only releases. Both carry the daemon assets.
const TAG_PREFIXES = ["pimi-all-v", "pimi-v"] as const;

export interface LocalBundle {
  file: string;
  sha256: string;
  size: number;
}

export interface BundleSourceOptions {
  version: string;
  arch: RemoteBundleArch;
  cacheDir: string;
  /** Unpackaged builds only: a directory holding the assets build-daemon-bundle.mjs wrote. */
  devBundleDir: string | null;
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
  signal?: AbortSignal;
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function parseChecksum(text: string, assetName: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/iu.exec(line.trim());
    if (match && match[2] === assetName) return match[1]?.toLowerCase() ?? null;
  }
  return null;
}

async function fetchChecked(url: string, signal?: AbortSignal): Promise<Response | null> {
  const response = await fetch(url, { redirect: "follow", signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response;
}

async function resolveDevBundle(options: BundleSourceOptions, dir: string): Promise<LocalBundle> {
  const asset = remoteBundleAssetName(options.arch);
  const file = path.join(dir, asset);
  let expected: string | null;
  try {
    expected = parseChecksum(await readFile(`${file}.sha256`, "utf8"), asset);
  } catch {
    throw new RemoteSshError(
      "BUNDLE_DOWNLOAD",
      `PIMI_REMOTE_DAEMON_BUNDLE_DIR has no ${asset}.sha256. Run scripts/build-daemon-bundle.mjs ${options.arch} first.`,
    );
  }
  const actual = await sha256OfFile(file);
  if (!expected || actual !== expected) {
    throw new RemoteSshError("BUNDLE_CHECKSUM", `${file} does not match its .sha256 file.`);
  }
  return { file, sha256: actual, size: (await stat(file)).size };
}

function cancelledOr(error: unknown, signal?: AbortSignal): never {
  if (error instanceof RemoteSshError) throw error;
  if (signal?.aborted) throw new RemoteSshError("CANCELLED", "Cancelled.");
  throw error;
}

async function cachedBundle(file: string, expected: string): Promise<LocalBundle | null> {
  try {
    if ((await sha256OfFile(file)) === expected) {
      return { file, sha256: expected, size: (await stat(file)).size };
    }
  } catch {
    // Not cached yet.
  }
  return null;
}

async function downloadBundle(
  url: string,
  file: string,
  expected: string,
  options: BundleSourceOptions,
): Promise<LocalBundle | null> {
  const partial = `${file}.part`;
  try {
    const response = await fetchChecked(url, options.signal);
    if (!response?.body) return null;
    const total = Number(response.headers.get("content-length")) || null;
    let received = 0;
    const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      options.onProgress?.(received, total);
    });
    await pipeline(body, createWriteStream(partial));
    const actual = await sha256OfFile(partial);
    if (actual !== expected) {
      throw new RemoteSshError(
        "BUNDLE_CHECKSUM",
        `The downloaded daemon bundle did not match SHA256SUMS.txt for Pimi ${options.version}, so Pimi discarded it. Try again; if it keeps failing, reinstall Pimi.`,
      );
    }
    await rename(partial, file);
    return { file, sha256: actual, size: (await stat(file)).size };
  } catch (error) {
    return cancelledOr(error, options.signal);
  } finally {
    await rm(partial, { force: true });
  }
}

/**
 * Finds the daemon bundle for this desktop version on this machine, downloading it from the
 * GitHub release that matches the version when it is not cached. The archive is verified against
 * the release's SHA256SUMS.txt every time it is used.
 */
export async function resolveLocalBundle(options: BundleSourceOptions): Promise<LocalBundle> {
  const asset = remoteBundleAssetName(options.arch);
  if (options.devBundleDir) return resolveDevBundle(options, options.devBundleDir);

  const dir = path.join(options.cacheDir, options.version);
  const file = path.join(dir, asset);
  await mkdir(dir, { recursive: true });

  let lastError = "";
  for (const prefix of TAG_PREFIXES) {
    const base = `${RELEASES_URL}/${prefix}${options.version}`;
    try {
      const response = await fetchChecked(`${base}/SHA256SUMS.txt`, options.signal);
      const expected = response ? parseChecksum(await response.text(), asset) : null;
      if (!expected) continue;
      const bundle =
        (await cachedBundle(file, expected)) ??
        (await downloadBundle(`${base}/${asset}`, file, expected, options));
      if (bundle) return bundle;
    } catch (error) {
      if (error instanceof RemoteSshError) throw error;
      if (options.signal?.aborted) throw new RemoteSshError("CANCELLED", "Cancelled.");
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new RemoteSshError(
    "BUNDLE_DOWNLOAD",
    `Pimi could not download the Linux daemon for version ${options.version} from github.com. Check this computer's internet connection and try again; the release must include ${asset}.`,
    lastError,
  );
}
