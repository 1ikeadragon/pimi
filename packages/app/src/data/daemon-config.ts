import AsyncStorage from "@react-native-async-storage/async-storage";
import { MutableDaemonConfigSchema, type MutableDaemonConfig } from "@pimi/protocol/messages";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";

export function daemonConfigQueryKey(serverId: string | null) {
  return ["daemon-config", serverId] as const;
}

// The config is mostly agent profiles (35 KB on a stock host) and rarely changes, so the last
// copy is kept per host with its hash. Reconnects and app launches send the hash and get no body
// back when it still matches.
const STORAGE_PREFIX = "@pimi/daemon-config/v1:";

interface StoredDaemonConfig {
  hash: string;
  config: MutableDaemonConfig;
}

const loaded = new Map<string, Promise<StoredDaemonConfig | null>>();

function readStored(serverId: string): Promise<StoredDaemonConfig | null> {
  let pending = loaded.get(serverId);
  if (!pending) {
    pending = (async () => {
      const raw = await AsyncStorage.getItem(STORAGE_PREFIX + serverId).catch(() => null);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { hash?: unknown; config?: unknown };
        const config = MutableDaemonConfigSchema.safeParse(parsed.config);
        if (typeof parsed.hash !== "string" || !config.success) return null;
        return { hash: parsed.hash, config: config.data };
      } catch {
        return null;
      }
    })();
    loaded.set(serverId, pending);
  }
  return pending;
}

function remember(serverId: string, stored: StoredDaemonConfig): void {
  loaded.set(serverId, Promise.resolve(stored));
  void AsyncStorage.setItem(STORAGE_PREFIX + serverId, JSON.stringify(stored)).catch(
    () => undefined,
  );
}

export async function fetchDaemonConfig(
  serverId: string,
  client: Pick<DaemonClient, "getDaemonConfig" | "getDaemonConfigIfChanged">,
): Promise<MutableDaemonConfig> {
  const known = await readStored(serverId);
  if (known) {
    const result = await client.getDaemonConfigIfChanged(known.hash);
    if (result.notModified) return known.config;
    remember(serverId, { hash: result.configHash, config: result.config });
    return result.config;
  }
  const result = await client.getDaemonConfig();
  remember(serverId, { hash: result.configHash, config: result.config });
  return result.config;
}
