#!/usr/bin/env node
// Downloads the betterleaks binary for the current (or specified) platform.
// Usage: node download-betterleaks.mjs [--platform win|mac|linux]

import { createWriteStream, existsSync, mkdirSync, chmodSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const VERSION = "1.10.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PLATFORMS = {
  win: { asset: `betterleaks_${VERSION}_windows_x64.zip`, bin: "betterleaks.exe", dir: "native/win/bin" },
  mac: { asset: `betterleaks_${VERSION}_darwin_arm64.tar.gz`, bin: "betterleaks", dir: "native/mac/bin" },
  linux: { asset: `betterleaks_${VERSION}_linux_x64.tar.gz`, bin: "betterleaks", dir: "native/linux/bin" },
};

function detectPlatform() {
  const arg = process.argv.find((a) => a.startsWith("--platform="))?.split("=")[1]
    ?? process.argv[process.argv.indexOf("--platform") + 1];
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

if (spec.asset.endsWith(".zip")) {
  const extractDir = path.join(os.tmpdir(), `betterleaks-extract-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });
  execFileSync("powershell.exe", [
    "-NoProfile", "-Command",
    `Expand-Archive -Path '${tmpArchive}' -DestinationPath '${extractDir}' -Force`,
  ]);
  const { copyFileSync } = await import("node:fs");
  copyFileSync(path.join(extractDir, spec.bin), outPath);
} else {
  execFileSync("tar", ["-xzf", tmpArchive, "-C", outDir, spec.bin]);
}

if (platform !== "win") chmodSync(outPath, 0o755);
console.log(`betterleaks v${VERSION} installed at ${outPath}`);
