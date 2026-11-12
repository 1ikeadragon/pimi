import { LegacyDaemonRunningError, migrateLegacyHome } from "@pimi/server/daemon-control";
import { runCli } from "./run.js";

// The first command after an upgrade moves a ~/.paseo home to ~/.pimi before anything else
// can fill the new home. Help and version output never touch a home. A command aimed at another
// daemon (--host) still moves a home nothing is using, but an old daemon still running from it
// is no reason to refuse a command that does not use it; a local command refuses instead.
const argv = process.argv.slice(2);
const isInformational = argv.some((arg) => /^(-h|--help|-V|--version)$/.test(arg));
const targetsOtherDaemon = argv.some((arg) => arg === "--host" || arg.startsWith("--host="));
if (!isInformational) {
  try {
    await migrateLegacyHome(process.env, (message) => console.error(message));
  } catch (error) {
    if (!(targetsOtherDaemon && error instanceof LegacyDaemonRunningError)) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}

const exitCode = await runCli(argv, {
  nodeArgv: [process.argv[0] ?? "node", process.argv[1] ?? "pimi"],
});
process.exitCode = exitCode;
