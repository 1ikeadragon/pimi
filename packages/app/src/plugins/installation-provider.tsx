import { QueryClientProvider } from "@tanstack/react-query";
import {
  PimiApiProvider,
  PluginClientStateProvider,
  PluginRpcProvider,
  PluginTranslationProvider,
} from "@pimi/plugin/client/host";
import type { PluginTheme } from "@pimi/plugin";
import React, { useMemo, type ReactNode } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "./client-state/source";
import { PluginInstallationContext, PluginThemeContext } from "./host-api/context";
import { toPluginTheme } from "./theme";
import type { InstalledPlugin } from "./types";

function ThemeContextBridge({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return <PluginThemeContext.Provider value={theme}>{children}</PluginThemeContext.Provider>;
}
const ThemedBridge = withUnistyles(ThemeContextBridge);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

/**
 * Every plugin component renders under its installation: one query cache, one Pimi client, RPCs,
 * the host's workspace and agent state, and the live theme. Screens, settings, panels, overrides,
 * and slots all get the same hooks from it.
 */
export function PluginInstallationProvider({
  plugin,
  children,
}: {
  plugin: InstalledPlugin;
  children: ReactNode;
}) {
  const state = useMemo(() => createPluginClientStateSource(plugin.serverId), [plugin.serverId]);
  return (
    <PluginInstallationContext.Provider value={plugin}>
      <QueryClientProvider client={plugin.queryClient}>
        <PimiApiProvider pimi={plugin.pimi}>
          <PluginRpcProvider invoke={plugin.invoke} subscribe={plugin.subscribe}>
            <PluginTranslationProvider runtime={plugin.i18n}>
              <PluginClientStateProvider source={state}>
                <ThemedBridge uniProps={themeMapping}>{children}</ThemedBridge>
              </PluginClientStateProvider>
            </PluginTranslationProvider>
          </PluginRpcProvider>
        </PimiApiProvider>
      </QueryClientProvider>
    </PluginInstallationContext.Provider>
  );
}
