import { readFile } from "node:fs/promises";
import path from "node:path";
import { classifyNetworkHost, normalizeNetworkHost } from "@pimi/protocol/network-activity";
import { writePrivateFileAtomic } from "../private-files.js";

// The destinations each program has been seen reaching, kept in <home>/network-baseline.json
// outside logs/ so the retention sweep never erases it. An entry is (program, host or IP, port,
// protocol) with first seen, last seen, a count, and whether the owner trusted it. It outlives
// the raw log window on purpose: "first seen" stays true after the log rolls over. Reset clears
// it. This is visibility, not enforcement: a compromised daemon can edit the file.

const FILE_NAME = "network-baseline.json";
const MAX_ENTRIES = 2000;
const SAVE_DELAY_MS = 2_000;

export interface BaselineEntry {
  key: string;
  program: string;
  /** The name when one was known at first sight, otherwise the IP. */
  host: string;
  address: string | null;
  port: number;
  protocol: "tcp" | "udp";
  root: string;
  firstSeenMs: number;
  lastSeenMs: number;
  count: number;
  trusted: boolean;
}

export function baselineKey(input: {
  program: string;
  host: string;
  port: number;
  protocol: string;
}): string {
  return [input.program, normalizeNetworkHost(input.host), input.port, input.protocol].join("|");
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

export function isIpOnly(entry: Pick<BaselineEntry, "host">): boolean {
  return isIpLiteral(entry.host);
}

export class NetworkBaseline {
  private readonly file: string;
  private readonly entries = new Map<string, BaselineEntry>();
  private readonly trustedHosts = new Set<string>();
  private readonly expectedHosts = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    home: string,
    private readonly onError: (error: unknown, message: string) => void,
  ) {
    this.file = path.join(home, FILE_NAME);
    this.ready = this.load();
  }

  /** Resolves once the file on disk has been read. Nothing is observed before that. */
  readonly ready: Promise<void>;

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.onError(error, "Could not read the network baseline");
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) return;
      for (const value of parsed.entries) {
        const entry = value as Partial<BaselineEntry>;
        if (
          typeof entry.key !== "string" ||
          typeof entry.program !== "string" ||
          typeof entry.host !== "string" ||
          typeof entry.port !== "number" ||
          (entry.protocol !== "tcp" && entry.protocol !== "udp") ||
          typeof entry.firstSeenMs !== "number" ||
          typeof entry.lastSeenMs !== "number" ||
          typeof entry.count !== "number"
        ) {
          continue;
        }
        this.entries.set(entry.key, {
          key: entry.key,
          program: entry.program,
          host: entry.host,
          address: typeof entry.address === "string" ? entry.address : null,
          port: entry.port,
          protocol: entry.protocol,
          root: typeof entry.root === "string" ? entry.root : "daemon",
          firstSeenMs: entry.firstSeenMs,
          lastSeenMs: entry.lastSeenMs,
          count: entry.count,
          trusted: entry.trusted === true,
        });
        if (entry.trusted === true) this.trustedHosts.add(normalizeNetworkHost(entry.host));
      }
    } catch (error) {
      this.onError(error, "The network baseline file is not valid JSON; starting empty");
    }
  }

  /** Counts one new connection. `created` is true the first time this destination is seen. */
  observe(input: {
    program: string;
    host: string;
    address: string | null;
    port: number;
    protocol: "tcp" | "udp";
    root: string;
    atMs: number;
  }): { entry: BaselineEntry; created: boolean } {
    const key = baselineKey(input);
    const existing = this.entries.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeenMs = input.atMs;
      // Re-insert so Map order stays least recently seen first.
      this.entries.delete(key);
      this.entries.set(key, existing);
      this.scheduleSave();
      return { entry: existing, created: false };
    }
    const entry: BaselineEntry = {
      key,
      program: input.program,
      host: normalizeNetworkHost(input.host),
      address: input.address,
      port: input.port,
      protocol: input.protocol,
      root: input.root,
      firstSeenMs: input.atMs,
      lastSeenMs: input.atMs,
      count: 1,
      trusted: false,
    };
    this.entries.set(key, entry);
    this.evict();
    this.scheduleSave();
    return { entry, created: true };
  }

  private evict(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) return;
      if (!entry.trusted) this.entries.delete(key);
    }
  }

  /**
   * Known needs a host or IP match: the owner trusted it, a name matched a host rule, the owner
   * configured it as a provider endpoint, or it is a private-network address. A launch's purpose
   * label alone never makes a destination known.
   */
  isKnown(entry: Pick<BaselineEntry, "host" | "trusted">): boolean {
    if (entry.trusted) return true;
    const host = normalizeNetworkHost(entry.host);
    if (this.expectedHosts.has(host)) return true;
    const classification = classifyNetworkHost(host);
    return classification.known;
  }

  /** A host the owner pointed a program at, such as a provider base URL. */
  expectHost(host: string): void {
    const normalized = normalizeNetworkHost(host);
    if (normalized && /^[a-z0-9.-]+$/.test(normalized)) this.expectedHosts.add(normalized);
  }

  expectedHostNames(): string[] {
    return [...this.expectedHosts];
  }

  hasTrustedHost(host: string): boolean {
    return this.trustedHosts.has(normalizeNetworkHost(host));
  }

  setTrusted(key: string, trusted: boolean): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.trusted = trusted;
    this.trustedHosts.clear();
    for (const other of this.entries.values()) {
      if (other.trusted) this.trustedHosts.add(other.host);
    }
    this.scheduleSave();
    return true;
  }

  reset(): void {
    this.entries.clear();
    this.trustedHosts.clear();
    this.scheduleSave();
  }

  get(key: string): BaselineEntry | undefined {
    return this.entries.get(key);
  }

  all(): IterableIterator<BaselineEntry> {
    return this.entries.values();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  /** Writes now. Called on shutdown so the last two seconds are not lost. */
  save(): Promise<void> {
    const body = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    this.pending = this.pending
      .then(() => writePrivateFileAtomic(this.file, body))
      .catch((error: unknown) => this.onError(error, "Could not save the network baseline"));
    return this.pending;
  }
}
