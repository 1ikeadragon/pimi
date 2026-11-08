import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

const RELEASE_ENDPOINT = "https://api.github.com/repos/1ikeadragon/pimi/releases/latest";
const RELEASE_ASSET_BASE = "https://github.com/1ikeadragon/pimi/releases/download";
const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const RELEASE_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
const GITHUB_MAX_ASSET_BYTES = 2 * 1024 ** 3 - 1;
const VERSION_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

const releaseSchema = z.object({
  immutable: z.literal(true),
  draft: z.literal(false),
  prerelease: z.literal(false),
  tag_name: z.string(),
  body: z.string().nullable(),
  published_at: z.iso.datetime(),
  assets: z.array(
    z.object({
      name: z.string(),
      state: z.literal("uploaded"),
      size: z.int().positive().max(GITHUB_MAX_ASSET_BYTES),
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      browser_download_url: z.string(),
    }),
  ),
});

export interface PimiUpdateRelease {
  version: string;
  notes: string | null;
  publishedAt: string;
  fileName: string;
  bytes: number;
  digest: string;
  url: string;
}

export function pimiUpdateAssetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin" && arch === "arm64") return "Pimi-macOS-arm64.dmg";
  if (platform === "win32" && arch === "x64") return "Pimi-Windows-x64.exe";
  return null;
}

export function isNewerPimiVersion(version: string, currentVersion: string): boolean {
  if (!VERSION_PATTERN.test(version) || !VERSION_PATTERN.test(currentVersion)) {
    throw new Error("Pimi updates require a valid stable version.");
  }
  const latest = version.split(".").map(Number);
  const current = currentVersion.split(".").map(Number);
  for (let index = 0; index < latest.length; index += 1) {
    if (latest[index] !== current[index]) return latest[index] > current[index];
  }
  return false;
}

function streamResponse(response: Response): Readable {
  if (!response.body) throw new Error("GitHub returned an empty response.");
  return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
}

export async function checkPimiRelease(
  fileName: string,
  currentVersion: string,
  signal?: AbortSignal,
): Promise<PimiUpdateRelease | null> {
  const timeout = AbortSignal.timeout(RELEASE_TIMEOUT_MS);
  const response = await fetch(RELEASE_ENDPOINT, {
    headers: { accept: "application/vnd.github+json" },
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Pimi could not check GitHub Releases (HTTP ${response.status}).`);
  }

  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of streamResponse(response)) {
    length += chunk.length;
    if (length > MAX_RELEASE_METADATA_BYTES) throw new Error("Pimi release metadata is too large.");
    chunks.push(chunk);
  }
  const parsed = releaseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!parsed.success || !parsed.data.tag_name.startsWith("pimi-v")) {
    throw new Error("GitHub did not return a verified immutable Pimi release.");
  }
  const release = parsed.data;
  const version = release.tag_name.slice("pimi-v".length);
  if (!isNewerPimiVersion(version, currentVersion)) return null;

  const matching = release.assets.filter((asset) => asset.name === fileName);
  const url = `${RELEASE_ASSET_BASE}/${release.tag_name}/${fileName}`;
  if (matching.length !== 1 || matching[0].browser_download_url !== url) {
    throw new Error("The immutable Pimi release is missing this platform’s installer.");
  }
  const asset = matching[0];
  return {
    version,
    notes: release.body,
    publishedAt: release.published_at,
    fileName,
    bytes: asset.size,
    digest: asset.digest.slice("sha256:".length),
    url,
  };
}

async function fetchPimiInstaller(url: string, signal: AbortSignal): Promise<Response> {
  let target = new URL(url);
  // GitHub redirects release downloads to its asset CDN. Never let a redirect
  // send the updater to an arbitrary host or local service.
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      !DOWNLOAD_HOSTS.has(target.hostname)
    ) {
      throw new Error("The Pimi installer URL left GitHub’s release service.");
    }
    const response = await fetch(target, { redirect: "manual", signal });
    if (response.status === 200) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      throw new Error(`Pimi could not download the installer (HTTP ${response.status}).`);
    }
    target = new URL(location, target);
  }
  throw new Error("The Pimi installer exceeded GitHub’s redirect limit.");
}

export async function downloadPimiInstaller(
  release: PimiUpdateRelease,
  cacheDirectory: string,
): Promise<string> {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(cacheDirectory, "download-"));
  const installer = path.join(directory, release.fileName);
  try {
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const response = await fetchPimiInstaller(release.url, signal);
    const hash = createHash("sha256");
    let bytes = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > release.bytes) return callback(new Error("The Pimi installer is too large."));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      streamResponse(response),
      measure,
      createWriteStream(installer, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (bytes !== release.bytes || hash.digest("hex") !== release.digest) {
      throw new Error("The Pimi installer did not match GitHub’s release digest.");
    }
    return installer;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function verifyPimiInstaller(
  release: PimiUpdateRelease,
  installer: string,
  signal?: AbortSignal,
): Promise<void> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(installer, { signal })) {
    bytes += chunk.length;
    if (bytes > release.bytes) throw new Error("The saved Pimi installer is too large.");
    hash.update(chunk);
  }
  if (bytes !== release.bytes || hash.digest("hex") !== release.digest) {
    throw new Error("The saved Pimi installer no longer matches GitHub’s release digest.");
  }
}
