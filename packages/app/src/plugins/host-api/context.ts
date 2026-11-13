import { createContext, useContext } from "react";
import type { PluginTheme } from "@pimi/plugin";
import type { InstalledPlugin } from "../types";

/** The installation whose component is rendering. Provided by `PluginInstallationProvider`. */
export const PluginInstallationContext = createContext<InstalledPlugin | null>(null);

export function useInstallation(): InstalledPlugin {
  const installation = useContext(PluginInstallationContext);
  if (!installation) throw new Error("Plugin hooks must run inside a plugin component");
  return installation;
}

export const PluginThemeContext = createContext<PluginTheme | null>(null);
