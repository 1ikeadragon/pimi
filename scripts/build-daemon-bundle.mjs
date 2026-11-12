#!/usr/bin/env node
// Builds the Linux daemon bundle that the desktop app installs on a remote dev machine over SSH.
//
//   node scripts/build-daemon-bundle.mjs <x64|arm64> [outDir]
//
// Run it after `npm run build:server`. It installs the production dependency closure of
// @pimi/server and @pimi/cli for linux-<arch> from the root package-lock.json into a scratch
// directory (npm cross-installs with --os/--cpu, so no Linux runner of the target arch is needed),
// copies the built workspace packages in as real directories, prunes what the daemon never loads,
// and writes outDir/Pimi-daemon-linux-<arch>.tar.gz plus a .sha256 file.
//
// The bundle holds no Node binary: the installer uses the remote's Node when it is new enough and
// downloads the official one otherwise. node-pty ships a linux prebuild per arch, so nothing is
// compiled.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arch = process.argv[2];
if (arch !== "x64" && arch !== "arm64") {
  console.error("Usage: node scripts/build-daemon-bundle.mjs <x64|arm64> [outDir]");
  process.exit(2);
}
const outDir = resolve(process.argv[3] ?? join(repoRoot, "packages/desktop/release-daemon"));

// Workspaces whose built output the daemon loads at runtime.
const RUNTIME_WORKSPACES = ["client", "highlight", "plugin", "protocol", "relay", "server", "cli"];
const NODE_MIN_MAJOR = 24;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const rootPackage = readJson(join(repoRoot, "package.json"));
const version = rootPackage.version;
for (const name of RUNTIME_WORKSPACES) {
  const dist = join(repoRoot, "packages", name, "dist");
  if (!existsSync(dist)) {
    throw new Error(`packages/${name}/dist is missing; run npm run build:server first.`);
  }
}

const nodeVersion = readFileSync(join(repoRoot, ".tool-versions"), "utf8")
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .find(([tool]) => tool === "nodejs")?.[1];
if (!nodeVersion || !/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
  throw new Error("Could not read the nodejs version from .tool-versions.");
}

const spec = readFileSync(
  join(repoRoot, "packages/desktop/src/daemon/remote-ssh/bundle-spec.ts"),
  "utf8",
);
if (!spec.includes(`REMOTE_NODE_VERSION = "${nodeVersion}"`)) {
  throw new Error(
    `REMOTE_NODE_VERSION in remote-ssh/bundle-spec.ts must be ${nodeVersion} (.tool-versions).`,
  );
}

function prune(path) {
  rmSync(path, { recursive: true, force: true });
}

function pruneMatching(dir, matches) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (matches(entry)) prune(join(dir, entry));
  }
}

function pruneBundle(nodeModules, targetArch) {
  const serverModules = join(nodeModules, "@pimi", "server", "node_modules");
  for (const root of [nodeModules, serverModules]) {
    // Per-platform Claude Code binaries (~200 MB each): Pimi uses the user's own `claude`.
    pruneMatching(join(root, "@anthropic-ai"), (name) => name.startsWith("claude-agent-sdk-"));
    const pty = join(root, "node-pty");
    pruneMatching(join(pty, "prebuilds"), (name) => name !== `linux-${targetArch}`);
    if (existsSync(pty)) prune(join(pty, "third_party"));
  }
  // Never loaded by the daemon: the plugin SDK's React Native peer chain (only plugin UI bundles
  // import it), and the packages electron-builder.yml also excludes from the desktop app.
  const unused =
    /^(react|react-native|hermes-compiler|react-devtools-core|metro(-.+)?|effect|fast-check|pure-rand|ai)$/;
  pruneMatching(nodeModules, (name) => unused.test(name));
  for (const scope of ["@react-native", "@babel", "@ai-sdk"]) prune(join(nodeModules, scope));
  prune(join(nodeModules, "@opencode", "protocol"));
  prune(join(nodeModules, "@opencode", "schema"));
  prune(join(nodeModules, "@anthropic-ai", "sdk"));
  // The compiler CLIs and locale tables are unused; the plugin compiler and tsserver stay.
  const lib = join(nodeModules, "typescript", "lib");
  pruneMatching(
    lib,
    (name) =>
      /^(_?tsc|_?typingsInstaller)\.js$/.test(name) || statSync(join(lib, name)).isDirectory(),
  );
}

const stage = mkdtempSync(join(tmpdir(), "pimi-daemon-stage-"));
const bundleDir = join(stage, "bundle");
try {
  // 1. Skeleton: lockfile + every workspace manifest, so `npm ci` validates the lock as usual.
  for (const file of ["package.json", "package-lock.json", ".npmrc"]) {
    cpSync(join(repoRoot, file), join(stage, file));
  }
  for (const workspace of rootPackage.workspaces) {
    const source = join(repoRoot, workspace, "package.json");
    mkdirSync(join(stage, workspace), { recursive: true });
    cpSync(source, join(stage, workspace, "package.json"));
  }

  // 2. Production closure for linux-<arch>. Lifecycle scripts stay off (.npmrc); node-pty and
  // sherpa-onnx ship prebuilt binaries.
  run(
    "npm",
    [
      "ci",
      "--omit=dev",
      "--omit=peer",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--os=linux",
      `--cpu=${arch}`,
      "--libc=glibc",
      "--workspace=@pimi/server",
      "--workspace=@pimi/cli",
    ],
    { cwd: stage },
  );

  // 3. Built workspace output next to each manifest.
  for (const name of RUNTIME_WORKSPACES) {
    const from = join(repoRoot, "packages", name);
    const to = join(stage, "packages", name);
    mkdirSync(to, { recursive: true });
    cpSync(join(from, "dist"), join(to, "dist"), {
      recursive: true,
      filter: (source) => !source.endsWith(".map"),
    });
    if (existsSync(join(from, "bin")))
      cpSync(join(from, "bin"), join(to, "bin"), { recursive: true });
  }

  // 4. The @opencode-ai/sdk patch the server depends on (see scripts/apply-patches.mjs).
  const patchDir = join(stage, "patches");
  mkdirSync(patchDir);
  const sdkPatch = readdirSync(join(repoRoot, "patches")).find((f) =>
    f.startsWith("@opencode-ai+sdk+"),
  );
  if (sdkPatch && existsSync(join(stage, "packages/server/node_modules/@opencode-ai/sdk"))) {
    cpSync(join(repoRoot, "patches", sdkPatch), join(patchDir, sdkPatch));
    const serverDir = join(stage, "packages/server");
    run(
      join(repoRoot, "node_modules/.bin/patch-package"),
      ["--patch-dir", relative(serverDir, patchDir), "--error-on-fail"],
      { cwd: serverDir },
    );
  }

  // 5. Flatten workspace symlinks into real directories.
  const nodeModules = join(stage, "node_modules");
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    const full = join(nodeModules, entry.name);
    if (entry.name === ".bin" || entry.name === ".package-lock.json") {
      rmSync(full, { recursive: true, force: true });
      continue;
    }
    if (entry.isSymbolicLink()) {
      // Top-level unscoped workspace links (e.g. "plugins" -> ../plugins) are not runtime deps.
      rmSync(full, { force: true });
    }
  }
  const pimiScope = join(nodeModules, "@pimi");
  if (existsSync(pimiScope)) {
    for (const entry of readdirSync(pimiScope, { withFileTypes: true })) {
      const link = join(pimiScope, entry.name);
      const keep = RUNTIME_WORKSPACES.includes(entry.name);
      if (entry.isSymbolicLink()) rmSync(link, { force: true });
      else if (!keep) rmSync(link, { recursive: true, force: true });
    }
  }
  mkdirSync(pimiScope, { recursive: true });
  for (const name of RUNTIME_WORKSPACES) {
    cpSync(join(stage, "packages", name), join(pimiScope, name), { recursive: true });
  }

  // 6. Prune what the daemon never loads on Linux.
  pruneBundle(nodeModules, arch);

  // 7. Manifest + tarball.
  mkdirSync(bundleDir);
  cpSync(nodeModules, join(bundleDir, "node_modules"), { recursive: true, dereference: true });
  const entry = "node_modules/@pimi/server/dist/scripts/supervisor-entrypoint.js";
  if (!existsSync(join(bundleDir, entry))) throw new Error(`Bundle is missing ${entry}`);
  writeFileSync(
    join(bundleDir, "bundle.json"),
    `${JSON.stringify({ version, arch, nodeVersion, nodeMinMajor: NODE_MIN_MAJOR, entry }, null, 2)}\n`,
  );

  mkdirSync(outDir, { recursive: true });
  const archive = join(outDir, `Pimi-daemon-linux-${arch}.tar.gz`);
  rmSync(archive, { force: true });
  // COPYFILE_DISABLE keeps macOS tar from adding ._ AppleDouble files.
  run("tar", ["-czf", archive, "-C", bundleDir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  Pimi-daemon-linux-${arch}.tar.gz\n`);
  console.log(`${archive} ${(statSync(archive).size / 1048576).toFixed(1)} MB sha256=${digest}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
