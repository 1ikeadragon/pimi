import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { helperPath } from "../../features/desktop-target/win/helper-process.js";
import { resolveNodeExecPath } from "../runtime-paths.js";
import type { SshTarget } from "./ssh-exec.js";

// ssh asks for passwords, key passphrases and verification codes through SSH_ASKPASS. This module
// answers them with an in-app prompt, over a socket that only an ssh child Pimi spawned can use
// (its per-spawn token). The answer never goes through env, argv, disk or logs. Answers to
// password and passphrase prompts are kept in memory until the app quits, so reconnects do not
// ask again; one-time codes are never kept.

export const AUTH_REQUEST_EVENT = "pimi:event:remote-ssh-auth-request";
export const AUTH_DISMISS_EVENT = "pimi:event:remote-ssh-auth-dismiss";

export interface SshAuthRequest {
  promptId: string;
  host: string;
  prompt: string;
  retry: boolean;
}

/** What a spawner needs to run one ssh child with in-app prompts. */
export interface SshAuth {
  interactive: boolean;
  env: NodeJS.ProcessEnv;
  attach(child: ChildProcess, hooks?: SshPromptHooks): void;
  wasCancelled(): boolean;
}

export interface SshPromptHooks {
  onPromptOpen(): void;
  onPromptClose(): void;
}

interface SshSpawn {
  token: string;
  hostKey: string;
  host: string;
  cancelled: boolean;
  /** Cache keys already answered for this spawn; asking one again means ssh rejected the answer. */
  answered: Set<string>;
  child: ChildProcess | null;
  hooks: SshPromptHooks | null;
  deniedByServer: boolean;
}

interface OpenPrompt {
  request: SshAuthRequest;
  spawn: SshSpawn;
  settle(secret: string | null, cancelled: boolean): void;
}

const PROMPT_LIMIT_MS = 120_000;
const REQUEST_READ_LIMIT_MS = 5_000;
const REQUEST_BYTE_LIMIT = 8 * 1024;
// ssh reads askpass output into a 1024-byte buffer.
export const SSH_SECRET_BYTE_LIMIT = 1000;
// OpenSSH added SSH_ASKPASS_REQUIRE in 8.4.
const ASKPASS_REQUIRE_MIN = { major: 8, minor: 4 };
const CACHEABLE_PROMPT = /pass(word|phrase)/iu;

const spawns = new Set<SshSpawn>();
const openPrompts = new Map<string, OpenPrompt>();
const secrets = new Map<string, string>();
// Machines where the user cancelled the prompt. Background reconnects fail fast instead of
// prompting again until the user adds the machine or upgrades it, or restarts the app.
const declined = new Set<string>();

let channel: { server: Server; address: string; dir: string | null } | null = null;
let channelStarting: Promise<string> | null = null;
let sshVersion: Promise<SshVersionCheck> | null = null;

type SshVersionCheck = "supported" | "too-old" | "unknown";

const hostKeyOf = (target: SshTarget): string => `${target.host}|${target.sshPort ?? ""}`;
const secretKey = (hostKey: string, prompt: string): string => `${hostKey}\0${prompt}`;

function checkSshVersion(): Promise<SshVersionCheck> {
  sshVersion ??= new Promise((resolve) => {
    const child = spawn("ssh", ["-V"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => resolve("unknown"));
    child.on("close", () => {
      const match = /OpenSSH(?:_for_Windows)?_(\d+)\.(\d+)/u.exec(output);
      if (!match) {
        resolve("unknown");
        return;
      }
      const major = Number(match[1]);
      const minor = Number(match[2]);
      const supported =
        major > ASKPASS_REQUIRE_MIN.major ||
        (major === ASKPASS_REQUIRE_MIN.major && minor >= ASKPASS_REQUIRE_MIN.minor);
      resolve(supported ? "supported" : "too-old");
    });
  });
  return sshVersion;
}

/** True when the system ssh is too old to take passwords from Pimi, for the sign-in error text. */
export async function sshTooOldForPasswords(): Promise<boolean> {
  return (await checkSshVersion()) === "too-old";
}

function askpassProgram(): { program: string; env: NodeJS.ProcessEnv } | null {
  if (process.platform === "win32") {
    // The helper exe doubles as the askpass program: a .cmd or script would hand ssh's
    // server-controlled prompt text to cmd.exe.
    const helper = helperPath();
    return existsSync(helper) ? { program: helper, env: { DISPLAY: "pimi" } } : null;
  }
  const script = app.isPackaged
    ? path.join(process.resourcesPath, "bin", "pimi-ssh-askpass")
    : path.resolve(__dirname, "../../../bin/pimi-ssh-askpass");
  const main = app.isPackaged
    ? path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "dist",
        "daemon",
        "remote-ssh",
        "askpass-client.js",
      )
    : path.join(__dirname, "askpass-client.js");
  if (!existsSync(script) || !existsSync(main)) return null;
  return {
    program: script,
    env: { PIMI_SSH_ASKPASS_NODE: resolveNodeExecPath(), PIMI_SSH_ASKPASS_MAIN: main },
  };
}

function startChannel(): Promise<string> {
  if (channel) return Promise.resolve(channel.address);
  channelStarting ??= new Promise<string>((resolve, reject) => {
    // A unix socket lives in a private 0700 directory. Node cannot set a Windows pipe ACL, so
    // the pipe name is random and every request still needs a spawn token.
    const dir =
      process.platform === "win32" ? null : mkdtempSync(path.join(os.tmpdir(), "pimi-askpass-"));
    const address = dir ? path.join(dir, "s.sock") : `\\\\.\\pipe\\pimi-askpass-${randomUUID()}`;
    const server = createServer(handleConnection);
    server.once("error", (error) => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      reject(error);
    });
    server.listen(address, () => {
      if (dir) chmodSync(address, 0o600);
      channel = { server, address, dir };
      resolve(address);
    });
  }).finally(() => {
    channelStarting = null;
  });
  return channelStarting;
}

function findSpawn(token: string): SshSpawn | null {
  const given = Buffer.from(token, "utf8");
  for (const candidate of spawns) {
    const expected = Buffer.from(candidate.token, "utf8");
    if (expected.length === given.length && timingSafeEqual(expected, given)) return candidate;
  }
  return null;
}

function handleConnection(socket: Socket): void {
  let received = "";
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  const deadline = setTimeout(() => socket.destroy(), REQUEST_READ_LIMIT_MS);
  socket.once("close", () => clearTimeout(deadline));
  const onData = (chunk: string) => {
    received += chunk;
    if (received.length > REQUEST_BYTE_LIMIT) {
      socket.destroy();
      return;
    }
    const lines = received.split("\n");
    if (lines.length < 3) return;
    clearTimeout(deadline);
    socket.off("data", onData);
    const [token = "", encodedPrompt = ""] = lines;
    const requester = findSpawn(token);
    if (!requester) {
      socket.destroy();
      return;
    }
    const prompt = Buffer.from(encodedPrompt, "base64").toString("utf8");
    void reply(socket, requester, prompt);
  };
  socket.on("data", onData);
}

async function reply(socket: Socket, requester: SshSpawn, prompt: string): Promise<void> {
  const secret = await answerPrompt(requester, prompt);
  socket.end(secret === null ? "NO\n" : `OK ${Buffer.from(secret, "utf8").toString("base64")}\n`);
}

function isCacheable(prompt: string): boolean {
  return CACHEABLE_PROMPT.test(prompt);
}

async function answerPrompt(requester: SshSpawn, prompt: string): Promise<string | null> {
  const key = secretKey(requester.hostKey, prompt);
  const retry = requester.answered.has(key);
  requester.answered.add(key);
  const cached = secrets.get(key);
  if (cached !== undefined && !retry) return cached;
  // Asked again within one spawn, or the cached answer is stale: ssh rejected it.
  secrets.delete(key);

  const secret = await askUser(requester, prompt, retry);
  if (secret === null) {
    cancelSpawn(requester);
    return null;
  }
  if (isCacheable(prompt)) secrets.set(key, secret);
  return secret;
}

function cancelSpawn(requester: SshSpawn): void {
  requester.cancelled = true;
  declined.add(requester.hostKey);
  // Left alone, ssh would send an empty password up to three times.
  requester.child?.kill();
}

function broadcast(event: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(event, payload);
}

function askUser(requester: SshSpawn, prompt: string, retry: boolean): Promise<string | null> {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!target) return Promise.resolve(null);
  let resolveAnswer: (secret: string | null) => void = () => undefined;
  const answer = new Promise<string | null>((resolve) => {
    resolveAnswer = resolve;
  });
  const request: SshAuthRequest = {
    promptId: randomUUID(),
    host: requester.host,
    prompt,
    retry,
  };
  const timer = setTimeout(() => settle(null, true), PROMPT_LIMIT_MS);
  function settle(secret: string | null, cancelled: boolean): void {
    if (!openPrompts.delete(request.promptId)) return;
    clearTimeout(timer);
    requester.hooks?.onPromptClose();
    broadcast(AUTH_DISMISS_EVENT, { promptId: request.promptId });
    if (cancelled) cancelSpawn(requester);
    resolveAnswer(secret);
  }
  openPrompts.set(request.promptId, { request, spawn: requester, settle });
  requester.hooks?.onPromptOpen();
  target.webContents.send(AUTH_REQUEST_EVENT, request);
  return answer;
}

/**
 * Prepares one ssh spawn. When the desktop can answer prompts, `env` and the interactive flag
 * make ssh ask through the app; otherwise ssh stays in batch mode, exactly as without this module.
 */
export async function prepareSshAuth(target: SshTarget): Promise<SshAuth> {
  const hostKey = hostKeyOf(target);
  const program = askpassProgram();
  const supported = (await checkSshVersion()) === "supported";
  if (!program || !supported || declined.has(hostKey)) {
    return { interactive: false, env: {}, attach: () => undefined, wasCancelled: () => false };
  }
  const address = await startChannel();
  const spawned: SshSpawn = {
    token: randomBytes(32).toString("hex"),
    hostKey,
    host: target.host,
    cancelled: false,
    answered: new Set(),
    child: null,
    hooks: null,
    deniedByServer: false,
  };
  spawns.add(spawned);
  return {
    interactive: true,
    env: {
      ...program.env,
      SSH_ASKPASS: program.program,
      SSH_ASKPASS_REQUIRE: "force",
      PIMI_SSH_ASKPASS_SOCK: address,
      PIMI_SSH_ASKPASS_TOKEN: spawned.token,
    },
    attach(child, hooks) {
      spawned.child = child;
      spawned.hooks = hooks ?? null;
      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-512);
        spawned.deniedByServer = /permission denied/iu.test(stderrTail);
      });
      child.once("close", () => {
        spawns.delete(spawned);
        for (const open of openPrompts.values()) {
          if (open.spawn === spawned) open.settle(null, false);
        }
        if (spawned.deniedByServer) {
          for (const key of spawned.answered) secrets.delete(key);
        }
      });
    },
    wasCancelled: () => spawned.cancelled,
  };
}

/** The user is about to set the machine up again, so prompting is welcome there. */
export function allowSshPrompts(target: SshTarget): void {
  declined.delete(hostKeyOf(target));
}

/** Drops every answer and the cancel mark for a machine, for when its connection is removed. */
export function forgetSshAuth(target: SshTarget): void {
  const hostKey = hostKeyOf(target);
  declined.delete(hostKey);
  for (const key of secrets.keys()) {
    if (key.startsWith(`${hostKey}\0`)) secrets.delete(key);
  }
}

export function pendingSshAuth(): SshAuthRequest[] {
  return Array.from(openPrompts.values(), (open) => open.request);
}

export function answerSshAuth(promptId: string, answer: { secret: string } | "cancel"): void {
  const open = openPrompts.get(promptId);
  if (!open) return;
  if (answer === "cancel") {
    open.settle(null, true);
    return;
  }
  if (Buffer.byteLength(answer.secret, "utf8") > SSH_SECRET_BYTE_LIMIT) {
    throw new Error("The answer is too long for ssh to read.");
  }
  open.settle(answer.secret, false);
}

/** Quit hook: closes the channel and removes its socket directory. */
export function disposeSshAuth(): void {
  for (const open of openPrompts.values()) open.settle(null, false);
  secrets.clear();
  const current = channel;
  channel = null;
  current?.server.close();
  if (current?.dir) rmSync(current.dir, { recursive: true, force: true });
}
