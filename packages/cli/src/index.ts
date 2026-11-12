import { migrateLegacyHome } from "@pimi/server/daemon-control";
import { runCli } from "./run.js";

// The first command after an upgrade moves a ~/.paseo home to ~/.pimi before anything
// else can create the new home.
try {
  await migrateLegacyHome(process.env, (message) => console.error(message));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const exitCode = await runCli(process.argv.slice(2), {
  nodeArgv: [process.argv[0] ?? "node", process.argv[1] ?? "pimi"],
});
process.exitCode = exitCode;
