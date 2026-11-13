import { useSyncExternalStore } from "react";
import { getDefaultBindings, subscribePluginShortcutBindings } from "./keyboard-shortcuts";

/** The built-in bindings plus those plugins added; a new reference whenever plugins change them. */
export function usePluginShortcutBindings() {
  return useSyncExternalStore(
    subscribePluginShortcutBindings,
    getDefaultBindings,
    getDefaultBindings,
  );
}
