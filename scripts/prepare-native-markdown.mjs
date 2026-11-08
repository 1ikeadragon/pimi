import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageDir = new URL(
  "../packages/app/node_modules/react-native-enriched-markdown/",
  import.meta.url,
);
const onlyIfInstalled = process.argv.includes("--if-installed");
if (
  onlyIfInstalled &&
  (!existsSync(packageDir) || process.env.PIMI_SKIP_NATIVE_MARKDOWN_ASSETS === "1")
) {
  process.exit(0);
}

const vendor = new URL("vendor-grammars.mjs", packageDir);
if (!readFileSync(vendor, "utf8").includes("Archive integrity mismatch for")) {
  throw new Error("Apply the native Markdown integrity patch before restoring grammar sources.");
}

const env = { ...process.env };
delete env.TREE_SITTER_SRC;
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(vendor),
    "--from-npm",
    "--vendor-dir",
    fileURLToPath(new URL("cpp/highlight/vendor", packageDir)),
    "--manifest",
    fileURLToPath(new URL("cpp/highlight/grammar-versions.json", packageDir)),
    "--integrity",
    fileURLToPath(new URL("native-markdown-grammars.integrity.json", import.meta.url)),
    ...(process.argv.includes("--force") ? ["--force"] : []),
  ],
  { env, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Native Markdown source verification failed.");
