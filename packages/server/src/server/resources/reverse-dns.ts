import dns from "node:dns";
import { classifyNetworkHost, NETWORK_PURPOSE } from "@pimi/protocol/network-activity";

// Opt-in PTR lookups that name the remote addresses in the Resources tab. Nothing is looked up
// until `name` is called, and the monitor calls it only while a client has asked for names.
// Misses are cached as well as hits so a quiet address is not asked about again within the TTL.

const TTL_MS = 60 * 60_000;
const MAX_ENTRIES = 2_000;
const TIMEOUT_MS = 2_000;
const MAX_CONCURRENT = 4;

// Taken before the network hooks wrap node:dns, so these lookups never log themselves.
const reverseUnobserved = dns.promises.reverse.bind(dns.promises);

interface CacheEntry {
  name: string | null;
  atMs: number;
}

export class ReverseNames {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private active = 0;

  /** The cached name, or null while unknown. An uncached public address is queued for lookup. */
  name(address: string): string | null {
    if (isPrivateOrLocal(address)) return null;
    const entry = this.cache.get(address);
    if (entry && Date.now() - entry.atMs < TTL_MS) return entry.name;
    if (!this.queued.has(address)) {
      this.queued.add(address);
      this.queue.push(address);
      this.pump();
    }
    return entry?.name ?? null;
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0) {
      const address = this.queue.shift()!;
      this.active += 1;
      lookup(address)
        .then((name) => this.store(address, name))
        .finally(() => {
          this.queued.delete(address);
          this.active -= 1;
          this.pump();
        });
    }
  }

  private store(address: string, name: string | null): void {
    this.cache.delete(address);
    this.cache.set(address, { name, atMs: Date.now() });
    if (this.cache.size > MAX_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
  }
}

function isPrivateOrLocal(address: string): boolean {
  const kind = classifyNetworkHost(address);
  return kind.local || kind.purpose === NETWORK_PURPOSE.localNetwork;
}

async function lookup(address: string): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    timer.unref();
  });
  try {
    const names = await Promise.race([reverseUnobserved(address).catch(() => null), timeout]);
    return names?.[0]?.replace(/\.$/, "") || null;
  } finally {
    clearTimeout(timer);
  }
}
