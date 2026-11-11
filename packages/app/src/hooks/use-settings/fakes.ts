import type { DesktopSettings } from "@/desktop/settings/desktop-settings";
import type { DesktopSettingsBridge, KeyValueStorage } from "./storage";

export interface InMemoryKeyValueStorage extends KeyValueStorage {
  readonly entries: Map<string, string>;
}

export function createInMemoryKeyValueStorage(
  initial: Record<string, string> = {},
): InMemoryKeyValueStorage {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    entries,
    async getItem(key) {
      return entries.get(key) ?? null;
    },
    async setItem(key, value) {
      entries.set(key, value);
    },
    async removeItem(key) {
      entries.delete(key);
    },
  };
}

const DEFAULT_DESKTOP: DesktopSettings = {
  releaseChannel: "stable",
  notifications: {
    playSound: true,
  },
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: false,
  },
};

export function createFakeDesktopBridge(
  options: {
    isElectron?: boolean;
    settings?: DesktopSettings;
  } = {},
): DesktopSettingsBridge {
  const isElectron = options.isElectron ?? false;
  const settings = options.settings ?? DEFAULT_DESKTOP;
  return {
    isElectron: () => isElectron,
    async loadDesktopSettings() {
      return settings;
    },
  };
}
