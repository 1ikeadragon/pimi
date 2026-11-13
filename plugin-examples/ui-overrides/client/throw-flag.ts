import { useSyncExternalStore } from "react";
import type { PluginClientStorage } from "@pimi/plugin/client";

const KEY = "throw";
const listeners = new Set<() => void>();
let value = false;

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getThrowFlag(): boolean {
  return value;
}

/** Loads the saved flag; the overrides read it through `useThrowFlag`. */
export async function loadThrowFlag(storage: PluginClientStorage): Promise<void> {
  value = (await storage.get<boolean>(KEY)) === true;
  for (const listener of listeners) listener();
}

export async function setThrowFlag(storage: PluginClientStorage, next: boolean): Promise<void> {
  value = next;
  for (const listener of listeners) listener();
  await storage.set(KEY, next);
}

export function useThrowFlag(): boolean {
  return useSyncExternalStore(subscribe, getThrowFlag, getThrowFlag);
}
