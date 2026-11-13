import type { PluginSidebarItemProps } from "@pimi/plugin/client";
import { SidebarRow } from "@pimi/plugin/client/ui";
import { useCallback } from "react";

export function MapSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "map" }), [openScreen]);
  return <SidebarRow icon="Map" active={currentScreen?.screenId === "map"} onPress={open} />;
}
