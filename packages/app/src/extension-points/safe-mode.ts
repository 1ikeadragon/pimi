import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { isWeb } from "@/constants/platform";
import { extensionRegistry } from "./registry";

const STORAGE_KEY = "@pimi:plugin-ui-safe-mode";

/**
 * Safe mode renders Pimi's own UI at every extension point while plugins stay installed and
 * running. It is on until storage has been read, so a stored "on" never loses a race with the
 * first render; plugin layers arrive after a host connects, which is later than that read.
 *
 * Three ways in: the setting on the Plugins page, `?safe=1` on the web and desktop renderer URL,
 * and a stored value from either. `?safe=1` does not persist.
 */
interface SafeModeState {
  hydrated: boolean;
  stored: boolean;
  forced: boolean;
}

let state: SafeModeState = { hydrated: false, stored: false, forced: readForcedFlag() };
const listeners = new Set<() => void>();

function readForcedFlag(): boolean {
  if (!isWeb || typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("safe") === "1";
  } catch {
    return false;
  }
}

function effective(value: SafeModeState): boolean {
  return !value.hydrated || value.stored || value.forced;
}

function update(next: SafeModeState): void {
  const before = effective(state);
  state = next;
  if (effective(state) !== before) {
    extensionRegistry.setSafeMode(effective(state));
    for (const listener of listeners) listener();
  }
}

extensionRegistry.setSafeMode(effective(state));
void AsyncStorage.getItem(STORAGE_KEY)
  .then((value) => update({ ...state, hydrated: true, stored: value === "1" }))
  .catch(() => update({ ...state, hydrated: true }));

export function setPluginUiSafeMode(enabled: boolean): void {
  update({ ...state, stored: enabled });
  void (
    enabled ? AsyncStorage.setItem(STORAGE_KEY, "1") : AsyncStorage.removeItem(STORAGE_KEY)
  ).catch((error) => console.warn("[Plugins] Could not save safe mode", error));
}

export function isPluginUiSafeMode(): boolean {
  return effective(state);
}

/** Why safe mode is on: the stored setting can be turned off in the UI; the URL flag cannot. */
export function getPluginUiSafeModeSource(): { stored: boolean; forced: boolean } {
  return { stored: state.stored, forced: state.forced };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePluginUiSafeMode(): boolean {
  return useSyncExternalStore(subscribe, isPluginUiSafeMode, isPluginUiSafeMode);
}
