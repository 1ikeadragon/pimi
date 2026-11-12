// COMPAT(paseo-home-mobile): earlier builds stored app state in AsyncStorage under "@paseo:*"
// (paired hosts in "@paseo:daemon-registry", settings, drafts) and "paseo:*" / "paseo-*" keys.
// The rename moved them to "@pimi:*", "pimi:*" and "pimi-*", so a phone updated in place would
// lose its pairing. This copies the old keys across once, before any store hydrates. Delete it
// with the daemon-home migration in packages/server/src/server/legacy-home-migration.ts.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

const DONE_KEY = "@pimi:legacy-paseo-storage-copied";
const LEGACY_KEY = /^(@?)paseo([:-])/;

export async function copyLegacyPaseoStorage(): Promise<void> {
  // The desktop renderer's localStorage is carried over by the desktop app itself.
  if (Platform.OS === "web") return;
  try {
    if ((await AsyncStorage.getItem(DONE_KEY)) !== null) return;
    const keys = await AsyncStorage.getAllKeys();
    const existing = new Set(keys);
    const pending = keys
      .filter((key) => LEGACY_KEY.test(key))
      .map((key) => [key, key.replace(LEGACY_KEY, "$1pimi$2")] as const)
      .filter(([, next]) => !existing.has(next));
    const values = await AsyncStorage.multiGet(pending.map(([key]) => key));
    const writes: Array<[string, string]> = [];
    values.forEach(([, value], index) => {
      const next = pending[index]?.[1];
      if (next && value !== null) {
        writes.push([next, value.split('"application/paseo-').join('"application/pimi-')]);
      }
    });
    if (writes.length > 0) await AsyncStorage.multiSet(writes);
    await AsyncStorage.setItem(DONE_KEY, new Date().toISOString());
  } catch (error) {
    // Starting without the old state beats not starting; the next launch retries.
    console.warn("[legacy-paseo-storage] could not copy old app state", error);
  }
}
