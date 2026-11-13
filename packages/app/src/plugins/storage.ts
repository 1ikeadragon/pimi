import AsyncStorage from "@react-native-async-storage/async-storage";
import type { JsonValue } from "@pimi/protocol/agent-types";
import type { PluginClientStorage } from "@pimi/plugin/client";

const PREFIX = "@pimi:plugin:";

/** Per-plugin, per-device storage. Keys are namespaced by plugin id, shared across its hosts. */
export function createPluginStorage(pluginId: string, signal: AbortSignal): PluginClientStorage {
  const prefix = `${PREFIX}${pluginId}:`;
  function assertActive(): void {
    if (signal.aborted) throw new Error("Plugin has stopped");
  }
  function storageKey(key: string): string {
    if (!key) throw new Error("Storage keys must not be empty");
    return `${prefix}${key}`;
  }
  return {
    async get<Value extends JsonValue = JsonValue>(key: string) {
      assertActive();
      const raw = await AsyncStorage.getItem(storageKey(key));
      return raw === null ? undefined : (JSON.parse(raw) as Value);
    },
    async set(key, value) {
      assertActive();
      await AsyncStorage.setItem(storageKey(key), JSON.stringify(value));
    },
    async delete(key) {
      assertActive();
      await AsyncStorage.removeItem(storageKey(key));
    },
    async keys() {
      assertActive();
      const all = await AsyncStorage.getAllKeys();
      return all
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .sort();
    },
  };
}
