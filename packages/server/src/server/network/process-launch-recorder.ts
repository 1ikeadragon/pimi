import { NETWORK_PURPOSE, type NetworkActivityRecorder } from "@pimi/protocol/network-activity";
import type { ProcessLaunchObserver } from "../../utils/process-launch.js";
import { commandBasename, outlineArgv, redactArgv } from "./redact.js";

// Programs whose arguments are mostly paths, refs, and subcommands. Anything else (agent
// providers, MCP servers, language servers) may carry prompts, inline JSON, or credentials in
// arguments, so only the outline of its command line is kept.
const FULL_ARGUMENT_PURPOSES = new Set<string>([
  NETWORK_PURPOSE.git,
  NETWORK_PURPOSE.githubCli,
  NETWORK_PURPOSE.gitHostCli,
]);

/**
 * Records each observed launch as protocol "process": the host is the program's basename, the
 * path is its redacted arguments, and the status is its exit code. The program's own network
 * traffic is not visible, only that it ran.
 */
export function createProcessLaunchObserver(
  recorder: NetworkActivityRecorder,
  source: string,
): ProcessLaunchObserver {
  return (launch) => {
    const record = recorder.start({
      source,
      method: "EXEC",
      protocol: "process",
      host: commandBasename(launch.command),
      port: null,
      path: FULL_ARGUMENT_PURPOSES.has(launch.purpose)
        ? redactArgv(launch.command, launch.args)
        : outlineArgv(launch.args),
      purpose: launch.purpose,
    });
    return (outcome) => {
      recorder.finish(record, {
        status: outcome.exitCode ?? null,
        errorCode:
          outcome.errorCode ?? (outcome.exitCode == null ? (outcome.signal ?? null) : null),
      });
    };
  };
}
