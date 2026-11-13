import { useContext } from "react";
import { useWindowDimensions } from "react-native";
import type { PluginClientStorage, PluginLayout, PluginNavigation } from "@pimi/plugin/client";
import type { PluginTheme } from "@pimi/plugin";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron } from "@/constants/platform";
import { resolvePluginPlatform } from "../platform";
import { PluginThemeContext, useInstallation } from "./context";
import { useMemo } from "react";

export function useTheme(): PluginTheme {
  const theme = useContext(PluginThemeContext);
  if (!theme) throw new Error("Plugin hooks must run inside a plugin component");
  return theme;
}

export function useLayout(): PluginLayout {
  const compact = useIsCompactFormFactor();
  const { width, height } = useWindowDimensions();
  return useMemo(
    () => ({
      compact,
      platform: resolvePluginPlatform(),
      isElectron: getIsElectron(),
      window: { width, height },
    }),
    [compact, width, height],
  );
}

export function useNavigation(): PluginNavigation {
  return useInstallation().navigation;
}

export function useClientStorage(): PluginClientStorage {
  return useInstallation().storage;
}
