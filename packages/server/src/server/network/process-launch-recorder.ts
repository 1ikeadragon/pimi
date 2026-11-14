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

const AGENT_PROVIDER_PROGRAMS = new Set([
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "gemini",
  "copilot",
  "cursor-agent",
  "agy",
  "antigravity",
  "qwen",
  "kimi",
  "droid",
]);
const GIT_HOST_PROGRAMS = new Set(["tea", "glab", "fj", "berg"]);

/** The purpose a launch gets when its call site did not say: decided by the program's name. */
function purposeForProgram(program: string): string {
  const name = program.toLowerCase();
  if (name === "git") return NETWORK_PURPOSE.git;
  if (name === "gh") return NETWORK_PURPOSE.githubCli;
  if (GIT_HOST_PROGRAMS.has(name)) return NETWORK_PURPOSE.gitHostCli;
  if (AGENT_PROVIDER_PROGRAMS.has(name)) return NETWORK_PURPOSE.agentProvider;
  if (/language-server|tsserver|^(gopls|rust-analyzer|pyright|clangd)/.test(name)) {
    return NETWORK_PURPOSE.languageServer;
  }
  return NETWORK_PURPOSE.process;
}

// Environment variables that point a provider CLI at a non-default endpoint. Only the host is
// ever read from them.
const PROVIDER_ENDPOINT_VARIABLES = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "GOOGLE_GEMINI_BASE_URL",
  "OPENROUTER_BASE_URL",
];
const GIT_NETWORK_SUBCOMMANDS = new Set([
  "clone",
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "submodule",
  "lfs",
  "remote",
]);
const URL_ARGUMENT = /^[a-z][a-z0-9+.-]*:\/\/([^/\s?#]+)/i;
const SCP_ARGUMENT = /^(?:[^@\s/:]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}):[^\s]/;

function hostOfUrlish(value: string): string | null {
  const url = URL_ARGUMENT.exec(value);
  if (url) return url[1]!.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
  const scp = SCP_ARGUMENT.exec(value);
  return scp ? scp[1]! : null;
}

function hostOfEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  return URL.parse(value)?.hostname || null;
}

/**
 * Where a launched program is expected to connect, when its arguments or environment say so.
 * Only a host is returned, never a path, credential, or the program's actual behavior. Null
 * when nothing explicit is known, which is the common case.
 */
function launchDestination(
  program: string,
  purpose: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): string | null {
  if (program === "git") {
    const subcommand = args.find(
      (argument) => !argument.startsWith("-") && !argument.includes("="),
    );
    if (!subcommand || !GIT_NETWORK_SUBCOMMANDS.has(subcommand)) return null;
    for (const argument of args) {
      const host = hostOfUrlish(argument);
      if (host) return host;
    }
    return "the remote configured in the repository";
  }
  if (program === "gh") {
    const hostFlag = args.findIndex((argument) => argument === "--hostname");
    const flagged = hostFlag === -1 ? undefined : args[hostFlag + 1];
    return flagged ?? env?.GH_HOST ?? "GitHub host from gh's own configuration";
  }
  if (purpose === NETWORK_PURPOSE.agentProvider) {
    for (const variable of PROVIDER_ENDPOINT_VARIABLES) {
      const host = hostOfEndpoint(env?.[variable]);
      if (host) return host;
    }
  }
  return null;
}

/**
 * Records each observed launch as protocol "process": the host is the program's basename, the
 * path is its redacted arguments, and the status is its exit code. The program's own network
 * traffic is not visible, only that it ran and, where its arguments or environment name one,
 * the destination it is expected to use.
 */
export interface SpawnedProgram {
  pid: number;
  program: string;
  purpose: string;
  agentId: string | null;
  /** A hostname the launch's own arguments or environment point at, such as a provider base URL. */
  expectedHost?: string;
}

export function createProcessLaunchObserver(
  recorder: NetworkActivityRecorder,
  source: string,
  onSpawn?: (spawned: SpawnedProgram) => void,
): ProcessLaunchObserver {
  return (launch) => {
    const program = commandBasename(launch.command);
    const purpose = launch.purpose ?? purposeForProgram(program);
    const record = recorder.start({
      source,
      method: "EXEC",
      protocol: "process",
      host: program,
      port: null,
      path: FULL_ARGUMENT_PURPOSES.has(purpose)
        ? redactArgv(launch.command, launch.args)
        : outlineArgv(launch.args),
      purpose,
      destination: launchDestination(program, purpose, launch.args, launch.env),
    });
    if (launch.agentId) record.agentId = launch.agentId;
    record.program = program;
    return {
      spawned: (pid) => {
        record.pid = pid;
        const destination = record.destination;
        onSpawn?.({
          pid,
          program,
          purpose,
          agentId: launch.agentId,
          ...(destination &&
          purpose === NETWORK_PURPOSE.agentProvider &&
          /^[a-z0-9.-]+$/i.test(destination)
            ? { expectedHost: destination }
            : {}),
        });
      },
      exited: (outcome) => {
        recorder.finish(record, {
          status: outcome.exitCode ?? null,
          errorCode:
            outcome.errorCode ?? (outcome.exitCode == null ? (outcome.signal ?? null) : null),
        });
      },
    };
  };
}
