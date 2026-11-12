import type { ProjectIcon } from "@pimi/protocol/messages";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import { projectIconCacheStorage } from "./icon-cache-storage";
import type { ProjectIconTarget } from "./icon-target";

const STORAGE_KEY = "@pimi:project-icon-cache";
const CACHE_VERSION = 1;
const PERSIST_DELAY_MS = 250;
const MAX_ENTRIES = 512;

export interface ProjectIconCacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface ProjectIconIdentity {
  serverId: string;
  projectId: string;
  revision: string;
}

type ProjectIconCacheRead = { hit: true; icon: ProjectIcon | null } | { hit: false };

interface StoredIcon extends ProjectIconIdentity {
  icon: ProjectIcon | null;
}

function keyOf(identity: ProjectIconIdentity): string {
  return JSON.stringify([identity.serverId, identity.projectId, identity.revision]);
}

function parseStoredIcon(value: unknown): StoredIcon | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.serverId !== "string" ||
    typeof entry.projectId !== "string" ||
    typeof entry.revision !== "string"
  ) {
    return null;
  }
  if (entry.icon === null) {
    return {
      serverId: entry.serverId,
      projectId: entry.projectId,
      revision: entry.revision,
      icon: null,
    };
  }
  if (!entry.icon || typeof entry.icon !== "object") return null;
  const icon = entry.icon as Record<string, unknown>;
  if (typeof icon.data !== "string" || typeof icon.mimeType !== "string") return null;
  return {
    serverId: entry.serverId,
    projectId: entry.projectId,
    revision: entry.revision,
    icon: { data: icon.data, mimeType: icon.mimeType },
  };
}

/** Owns project-icon persistence, revision matching, and negative results. */
export class ProjectIconCache {
  private readonly entries = new Map<string, StoredIcon>();
  private activeServerIds = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: ProjectIconCacheStorage) {}

  setHosts(serverIds: Iterable<string>): void {
    this.activeServerIds = new Set(serverIds);
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (!this.activeServerIds.has(entry.serverId)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.schedulePersist();
  }

  async restore(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.storage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return;
      for (const value of parsed.entries) {
        const entry = parseStoredIcon(value);
        if (entry && this.activeServerIds.has(entry.serverId)) {
          this.entries.set(keyOf(entry), entry);
        }
      }
    } catch {
      // A corrupt cache is disposable.
    }
  }

  private read(identity: ProjectIconIdentity): ProjectIconCacheRead {
    const entry = this.entries.get(keyOf(identity));
    return entry ? { hit: true, icon: entry.icon } : { hit: false };
  }

  private write(identity: ProjectIconIdentity, icon: ProjectIcon | null): void {
    const key = keyOf(identity);
    this.entries.delete(key);
    this.entries.set(key, { ...identity, icon });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.schedulePersist();
  }

  query(target: ProjectIconTarget, getClient: () => DaemonClient | null, connected: boolean) {
    // Projects without an effective revision (empty-project descriptors) stay memory-only.
    const revision = target.iconRevision ?? target.customIconRevision ?? "automatic";
    const identity: ProjectIconIdentity | null = target.iconRevision
      ? { serverId: target.serverId, projectId: target.projectId, revision: target.iconRevision }
      : null;
    const cached = identity ? this.read(identity) : { hit: false as const };
    return {
      queryKey: ["projectIcon", target.serverId, target.projectId, revision],
      queryFn: async () => {
        const client = getClient();
        if (!client) return null;
        const result = await client.getProjectIcon(target.projectId);
        if (result.error) throw new Error(result.error);
        if (identity) this.write(identity, result.icon);
        return result.icon;
      },
      enabled: Boolean(getClient() && connected),
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60,
      refetchOnMount: false as const,
      refetchOnWindowFocus: false as const,
      refetchOnReconnect: false as const,
      ...(cached.hit ? { initialData: cached.icon } : {}),
    };
  }

  reconcileServerId(oldServerId: string, newServerId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.serverId !== oldServerId) continue;
      this.entries.delete(key);
      const reconciled = { ...entry, serverId: newServerId };
      this.entries.set(keyOf(reconciled), reconciled);
    }
    if (this.activeServerIds.delete(oldServerId)) this.activeServerIds.add(newServerId);
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const payload = JSON.stringify({ version: CACHE_VERSION, entries: [...this.entries.values()] });
    const write = this.writeQueue
      .catch(() => undefined)
      .then(() => this.storage.setItem(STORAGE_KEY, payload));
    this.writeQueue = write;
    await write.catch(() => undefined);
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DELAY_MS);
  }
}

export const projectIconCache = new ProjectIconCache(projectIconCacheStorage);
