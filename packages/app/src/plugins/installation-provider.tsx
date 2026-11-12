import { QueryClientProvider } from "@tanstack/react-query";
import {
  PimiApiProvider,
  PluginRpcProvider,
  PluginTranslationProvider,
} from "@pimi/plugin/client/host";
import React, { type ReactNode } from "react";
import type { InstalledPlugin } from "./types";

/** Every plugin surface renders under its installation: one query cache, one Pimi client, RPCs. */
export function PluginInstallationProvider({
  plugin,
  children,
}: {
  plugin: InstalledPlugin;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <PimiApiProvider pimi={plugin.pimi}>
        <PluginRpcProvider invoke={plugin.invoke} subscribe={plugin.subscribe}>
          <PluginTranslationProvider runtime={plugin.i18n}>{children}</PluginTranslationProvider>
        </PluginRpcProvider>
      </PimiApiProvider>
    </QueryClientProvider>
  );
}
