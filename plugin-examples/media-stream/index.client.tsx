import type { PluginClientContext } from "@pimi/plugin/client";
import { MediaPanel } from "./client/media-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "media",
    title: "Media stream",
    icon: "MonitorPlay",
    Component: MediaPanel,
  });
  client.addCommandCenterItem({
    id: "open-media",
    title: "Open media stream",
    icon: "MonitorPlay",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("media");
    },
  });
  return () => {};
}
