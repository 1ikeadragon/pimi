import { useEffect, useMemo } from "react";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { setPluginShortcutBindings, type PluginShortcutInput } from "@/keyboard/keyboard-shortcuts";
import type { InstalledPlugin } from "../types";

/** Commands the current context can run, by `<pluginId>:<itemId>`. Rebuilt with the Command Center items. */
let runners = new Map<string, () => void | Promise<void>>();

export function setPluginCommandRunners(actions: readonly CommandCenterContribution[]): void {
  runners = new Map(
    actions.filter((action) => action.id.includes(":")).map((action) => [action.id, action.run]),
  );
}

/**
 * Runs a plugin command for a keyboard shortcut. False when the current context cannot run it, for
 * example a workspace command with no workspace open, so the key is left to the app.
 */
export function runPluginCommand(key: string): boolean {
  const run = runners.get(key);
  if (!run) return false;
  void run();
  return true;
}

/**
 * Registers the shortcuts plugins declared on Command Center items. Bindings are app-wide: a
 * command declared by the same plugin on several hosts binds once, from the first host by id.
 */
export function usePluginShortcutRegistration(installed: readonly InstalledPlugin[]): void {
  const inputs = useMemo(() => {
    const byKey = new Map<string, PluginShortcutInput>();
    const ordered = [...installed].sort((left, right) => (left.serverId < right.serverId ? -1 : 1));
    for (const plugin of ordered) {
      for (const item of plugin.commandCenterItems) {
        if (!item.shortcut) continue;
        const key = `${plugin.id}:${item.id}`;
        if (byKey.has(key)) continue;
        byKey.set(key, {
          key,
          shortcut: item.shortcut,
          label: plugin.i18n.resolve(item.title, plugin.locale),
        });
      }
    }
    return [...byKey.values()].sort((left, right) => (left.key < right.key ? -1 : 1));
  }, [installed]);
  useEffect(() => {
    setPluginShortcutBindings(inputs);
    return () => setPluginShortcutBindings([]);
  }, [inputs]);
}
