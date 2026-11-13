import type { PluginClientContext } from "@pimi/plugin/client";
import { MapSidebarItem } from "./client/sidebar-item";
import { MapScreen } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  const removals = [
    client.addScreen({ id: "map", title: "Repo Map", Component: MapScreen }),
    client.addSidebarHeaderItem({ id: "map", title: "Repo Map", Component: MapSidebarItem }),
    client.addCommandCenterItem({
      id: "open",
      title: "Open Repo Map",
      icon: "Map",
      context: "workspace",
      shortcut: "mod+alt+m",
      onSelect({ workspace, openScreen }) {
        openScreen({ screenId: "map", params: { workspaceId: workspace.id } });
      },
    }),
    client.addMenuItem({
      menu: "file-tree-row",
      id: "reveal",
      title: "Show in Repo Map",
      icon: "Map",
      run({ workspaceId, path }) {
        client.openScreen({ screenId: "map", params: { workspaceId, focus: path } });
      },
    }),
  ];
  return () => {
    for (const remove of removals) void remove();
  };
}
