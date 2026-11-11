// Writes the pimi-visualize skill's formats.md from the same constants the block parsers use,
// so the skill and the parsers cannot disagree. Runs after tsc in the protocol build.
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { PIMI_VISUALIZATION_INSTRUCTIONS } = await import(
  pathToFileURL(resolve(packageRoot, "dist/chat-visualization.js")).href
);
const output = resolve(packageRoot, "../../skills/pimi-visualize/formats.md");
const header =
  "# Block formats\n\nGenerated from the block parsers by `packages/protocol/scripts/generate-visualize-formats.mjs`. Do not edit by hand.\n\n";
await writeFile(output, `${header}${PIMI_VISUALIZATION_INSTRUCTIONS}\n`);
console.log("generated skills/pimi-visualize/formats.md");
