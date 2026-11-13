#!/usr/bin/env node
// Builds native/win/pimi-desktop-helper.exe (C#, .NET Framework 4.8, x64) and copies it,
// with the DLLs it needs, into native/win/bin/. Windows only.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("build-win-helper: skipped (not Windows)");
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const winDir = path.resolve(here, "..", "native", "win");
const csproj = path.join(winDir, "PimiDesktopHelper.csproj");
const outDir = path.join(winDir, "bin");
const buildOut = path.join(winDir, "obj", "publish-out");

const probe = spawnSync("dotnet", ["--version"], { encoding: "utf8", shell: false });
if (probe.error || probe.status !== 0) {
  console.error(
    "build-win-helper: the .NET SDK (`dotnet`) was not found on PATH.\n" +
      "Install it with `winget install Microsoft.DotNet.SDK.8` and open a new terminal,\n" +
      "or drop pimi-desktop-helper.exe from the latest Pimi release into packages/desktop/native/win/bin/.",
  );
  process.exit(1);
}

rmSync(buildOut, { recursive: true, force: true });
const build = spawnSync(
  "dotnet",
  ["build", csproj, "-c", "Release", "-nologo", "-v", "minimal", "-o", buildOut],
  { stdio: "inherit", shell: false },
);
if (build.status !== 0) {
  console.error("build-win-helper: dotnet build failed.");
  process.exit(build.status ?? 1);
}

const exe = path.join(buildOut, "pimi-desktop-helper.exe");
if (!existsSync(exe)) {
  console.error(`build-win-helper: expected ${exe} after the build.`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const copied = [];
for (const name of readdirSync(buildOut)) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdb") || lower.endsWith(".xml")) continue;
  if (!lower.endsWith(".exe") && !lower.endsWith(".dll") && !lower.endsWith(".config")) continue;
  copyFileSync(path.join(buildOut, name), path.join(outDir, name));
  copied.push(name);
}
console.log(`build-win-helper: wrote ${path.relative(process.cwd(), outDir)} (${copied.join(", ")})`);
