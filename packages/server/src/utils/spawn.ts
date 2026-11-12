import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawnProcess as spawnCli, execCommand as execCli } from "@pimi/plugin/server";
import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "../server/pimi-env.js";
import { withLaunchPurpose } from "./process-launch.js";

interface ExternalEnvOptions {
  baseEnv?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
  /** Labels the launch in the Network tab (a NETWORK_PURPOSE). Without it the program name decides. */
  networkPurpose?: string;
}

export type SpawnProcessOptions = Omit<SpawnOptions, "env"> & ExternalEnvOptions;

interface ExecCommandOptions extends ExternalEnvOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  killSignal?: NodeJS.Signals;
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  signal?: AbortSignal;
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { baseEnv, env, envOverlay, networkPurpose, ...spawnOptions } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  const launch = () =>
    spawnCli(command, args, {
      ...spawnOptions,
      env: childEnv,
      signal: options?.signal,
    });
  return networkPurpose ? withLaunchPurpose(networkPurpose, launch) : launch();
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const { baseEnv, env, envOverlay } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  const run = () =>
    execCli(command, args, {
      cwd: options?.cwd,
      env: childEnv,
      shell: options?.shell,
      encoding: options?.encoding ?? "utf8",
      signal: options?.signal,
      killSignal: options?.killSignal,
      timeout: options?.timeout,
      maxBuffer: options?.maxBuffer,
    }) as Promise<ExecCommandResult>;
  return options?.networkPurpose ? withLaunchPurpose(options.networkPurpose, run) : run();
}
