#!/usr/bin/env node
// Downloads the betterleaks binary for the current (or specified) platform.
// Usage: node download-betterleaks.mjs [--platform win|mac|linux]

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const VERSION = "1.10.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PLATFORMS = {
  win: {
    asset: `betterleaks_${VERSION}_windows_x64.zip`,
    sha256: "53d4b37635a999992fb8e1d79f8215279315cbb3b4139314289b69407e79143d",
    bin: "betterleaks.exe",
    dir: "native/win/bin",
  },
  mac: {
    asset: `betterleaks_${VERSION}_darwin_arm64.tar.gz`,
    sha256: "ca91eb3b006f15478411f235b5e2712fb15cea74f6701ebadc2364efe0af1403",
    bin: "betterleaks",
    dir: "native/mac/bin",
  },
  linux: {
    asset: `betterleaks_${VERSION}_linux_x64.tar.gz`,
    sha256: "c174b42d7aa60caf58c0c3e555c0e4bed01fe6b0d99a412bce777b5af4ce913e",
    bin: "betterleaks",
    dir: "native/linux/bin",
  },
};
// The SHA-256s come from the immutable v1.10.1 release (GitHub's per-asset digests, which match
// its checksums.txt). The binary ships inside the signed app, so a changed archive must fail the
// build. Bumping VERSION means re-reading the new release's digests and updating these.

function detectPlatform() {
  const arg =
    process.argv.find((a) => a.startsWith("--platform="))?.split("=")[1] ??
    process.argv[process.argv.indexOf("--platform") + 1];
  if (arg && arg in PLATFORMS) return arg;
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

const platform = detectPlatform();
const spec = PLATFORMS[platform];
const outDir = path.resolve(ROOT, spec.dir);
const outPath = path.join(outDir, spec.bin);

if (existsSync(outPath)) {
  console.log(`betterleaks already exists at ${outPath}`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const url = `https://github.com/betterleaks/betterleaks/releases/download/v${VERSION}/${spec.asset}`;
const tmpArchive = path.join(os.tmpdir(), spec.asset);

console.log(`Downloading betterleaks v${VERSION} for ${platform}...`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
await pipeline(res.body, createWriteStream(tmpArchive));
const actual = createHash("sha256").update(readFileSync(tmpArchive)).digest("hex");
if (actual !== spec.sha256) {
  throw new Error(
    `betterleaks ${spec.asset}: SHA-256 ${actual} does not match pinned ${spec.sha256}`,
  );
}

if (spec.asset.endsWith(".zip")) {
  const extractDir = path.join(os.tmpdir(), `betterleaks-extract-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path '${tmpArchive}' -DestinationPath '${extractDir}' -Force`,
  ]);
  const { copyFileSync } = await import("node:fs");
  copyFileSync(path.join(extractDir, spec.bin), outPath);
} else {
  execFileSync("tar", ["-xzf", tmpArchive, "-C", outDir, spec.bin]);
}

if (platform !== "win") chmodSync(outPath, 0o755);
console.log(`betterleaks v${VERSION} installed at ${outPath}`);
