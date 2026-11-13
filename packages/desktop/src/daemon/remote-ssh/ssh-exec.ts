import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { sshAuthModeArgs, validatePort, validateSshHost } from "@pimi/protocol/ssh-transport";
import { RemoteSshError, errorFromRemoteScript, errorFromSshStderr } from "./errors.js";

export interface SshTarget {
  host: string;
  sshPort?: number;
}

export interface SshRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SshRunOptions {
  stdin?: Readable;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
}

const OUTPUT_LIMIT = 256 * 1024;

/**
 * `-F <file>` for every ssh Pimi starts when PIMI_SSH_CONFIG is set. Without it ssh reads
 * ~/.ssh/config as usual; this is for a dedicated config, e.g. a throwaway test machine.
 */
export function sshConfigArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = env.PIMI_SSH_CONFIG?.trim();
  return file ? ["-F", file] : [];
}

/** Always the system ssh: it applies ~/.ssh/config, ProxyJump, keys and the agent. */
export function buildSshExecArgs(
  target: SshTarget,
  remoteCommand: string,
  interactive: boolean,
): string[] {
  const host = validateSshHost(target.host);
  const args = [
    ...sshConfigArgs(),
    "-T",
    ...sshAuthModeArgs(interactive),
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    // First contact trusts the key and records it; a key that later changes is still refused.
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ClearAllForwardings=yes",
  ];
  if (target.sshPort !== undefined)
    args.push("-p", String(validatePort(target.sshPort, "SSH port")));
  args.push(host, remoteCommand);
  return args;
}

const SAFE_ARG = /^[A-Za-z0-9._:/@=+-]+$/u;

/** Wraps a script so the remote login shell, whatever it is, only sees single-quoted sh. */
export function remoteScriptCommand(script: string, args: string[]): string {
  for (const arg of args) {
    if (!SAFE_ARG.test(arg)) throw new Error(`Unsafe remote script argument: ${arg}`);
  }
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `sh -c 'sh -c "$(printf %s ${encoded} | base64 -d)" sh ${args.join(" ")}'`;
}

export function runSsh(
  target: SshTarget,
  remoteCommand: string,
  options: SshRunOptions = {},
): Promise<SshRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", buildSshExecArgs(target, remoteCommand, false), {
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(new RemoteSshError("CANCELLED", "Cancelled.")));
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          finish(() =>
            reject(
              new RemoteSshError(
                "SSH_TIMEOUT",
                `The SSH connection to ${target.host} timed out. Check the network or VPN and try again.`,
              ),
            ),
          );
        }, options.timeoutMs)
      : undefined;
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-OUTPUT_LIMIT);
      if (options.onStdoutLine) {
        pending += text;
        let index = pending.indexOf("\n");
        while (index >= 0) {
          options.onStdoutLine(pending.slice(0, index));
          pending = pending.slice(index + 1);
          index = pending.indexOf("\n");
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-OUTPUT_LIMIT);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ENOENT"
            ? new RemoteSshError(
                "SSH_MISSING",
                "Pimi could not find the ssh command. Install the OpenSSH client (on Windows: Settings > Apps > Optional features > OpenSSH Client) and try again.",
              )
            : new RemoteSshError("SSH_FAILED", `Could not start ssh: ${error.message}`),
        ),
      );
    });
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    if (options.stdin && child.stdin) {
      child.stdin.on("error", () => undefined);
      options.stdin.on("error", (error) => {
        child.kill();
        finish(() =>
          reject(
            new RemoteSshError("UPLOAD_FAILED", `Reading the bundle failed: ${error.message}`),
          ),
        );
      });
      options.stdin.pipe(child.stdin);
    }
  });
}

/** Runs a remote script and returns its stdout, turning every failure into a RemoteSshError. */
export async function runRemoteScript(
  target: SshTarget,
  script: string,
  args: string[],
  options: SshRunOptions & { onStep?: (step: string) => void } = {},
): Promise<string> {
  const result = await runSsh(target, remoteScriptCommand(script, args), {
    ...options,
    onStdoutLine: (line) => {
      if (line.startsWith("PIMI_STEP ")) options.onStep?.(line.slice("PIMI_STEP ".length).trim());
    },
  });
  const failure = /^PIMI_ERROR (\S+) ?(.*)$/mu.exec(result.stdout);
  if (failure) throw errorFromRemoteScript(failure[1] ?? "", failure[2] ?? "");
  if (result.code !== 0) throw errorFromSshStderr(target.host, result.stderr, result.code);
  return result.stdout;
}

export function parseFacts(stdout: string): Map<string, string[]> {
  const facts = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0 || line.startsWith("PIMI_")) continue;
    const key = line.slice(0, index);
    const list = facts.get(key) ?? [];
    list.push(line.slice(index + 1).trim());
    facts.set(key, list);
  }
  return facts;
}
