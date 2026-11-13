import type { PluginClientContext } from "@pimi/plugin/client";
import { AboutOverride } from "./client/about-section";
import { OverridesSettings } from "./client/settings";
import { loadThrowFlag } from "./client/throw-flag";
import { UserBubble } from "./client/user-message";
import { WorkspaceBadge } from "./client/workspace-badge";

export default function contribute(client: PluginClientContext) {
  void loadThrowFlag(client.storage);
  const removals = [
    client.overrideComponent("chat.userMessage", UserBubble),
    client.wrapComponent("sidebar.workspaceRow", WorkspaceBadge),
    client.overrideComponent("settings.section", AboutOverride),
    client.addSettingsScreen({
      id: "overrides",
      title: "UI Overrides",
      icon: "Palette",
      Component: OverridesSettings,
    }),
  ];
  return () => {
    for (const remove of removals) void remove();
  };
}
