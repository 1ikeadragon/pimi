#!/usr/bin/env node
// Builds native/mac/bin/pimi-desktop-helper and native/mac-vault/bin/pimi-vault-key from the Swift
// sources next to them with swiftc. The vault key helper is separate because the desktop helper
// holds Accessibility permission and the vault key must not sit behind it.
// Apple frameworks only: no SwiftPM, no packages, no third-party code. macOS only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("build-mac-helper: skipped (not macOS)");
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = path.resolve(here, "..", "native");

const probe = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.error(
    "build-mac-helper: swiftc was not found. Install the Xcode command line tools with `xcode-select --install`.",
  );
  process.exit(1);
}

function buildHelper(directory, binaryName) {
  const sourceDir = path.join(nativeDir, directory);
  const outDir = path.join(sourceDir, "bin");
  const output = path.join(outDir, binaryName);
  const sources = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => path.join(sourceDir, name));
  if (sources.length === 0) {
    console.error(`build-mac-helper: no Swift sources in ${sourceDir}.`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  // Only the helper is replaced: bin/ also holds the betterleaks download.
  const build = spawnSync(
    "swiftc",
    [
      "-O",
      "-parse-as-library",
      "-swift-version",
      "5",
      "-target",
      "arm64-apple-macos13.0",
      ...sources,
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
  if (build.status !== 0 || !existsSync(output)) {
    console.error(`build-mac-helper: swiftc failed for ${binaryName}.`);
    process.exit(build.status ?? 1);
  }
  console.log(`build-mac-helper: wrote ${path.relative(process.cwd(), output)}`);
}

buildHelper("mac", "pimi-desktop-helper");
buildHelper("mac-vault", "pimi-vault-key");
