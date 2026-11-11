import type { PluginClientContext } from "@pimi/plugin/client";
import { DiffPanel } from "./client/diff-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "changes",
    title: "Live changes",
    icon: "GitCompare",
    Component: DiffPanel,
  });
  client.addCommandCenterItem({
    id: "open-changes",
    title: "Open live changes",
    icon: "GitCompare",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("changes");
    },
  });
  return () => {};
}
