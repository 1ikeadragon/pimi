import { PluginTranslationRuntime } from "@pimi/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import { pluginScreensHostKey, rememberPluginContributionHost } from "./contribution-host";
import { groupPluginSidebarItems, selectPluginSidebarTarget } from "./sidebar-groups";

function installed(
  serverId: string,
  contributionId = "main",
  pluginId = "example",
): InstalledPlugin {
  return {
    id: pluginId,
    cleanup: () => undefined,
    serverId,
    clientBundle: serverId,
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    subscribe: () => {
      throw new Error("Subscriptions are not used here");
    },
    settingsScreens: [],
    surfaces: [{ id: "surface", title: "Surface", Component: () => null }],
    sidebarItems: {
      header: [{ id: contributionId, title: "Example", Component: () => null }],
      footer: [{ id: "status", title: "Status", Component: () => null }],
    },
    filePanels: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

describe("groupPluginSidebarItems", () => {
  it("coalesces the same plugin contribution across hosts", () => {
    const groups = groupPluginSidebarItems([installed("host-a"), installed("host-b")], "header");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.targets.map((target) => target.plugin.serverId)).toEqual([
      "host-a",
      "host-b",
    ]);
  });

  it("keeps different contribution ids separate", () => {
    const groups = groupPluginSidebarItems(
      [installed("host-a", "main"), installed("host-b", "settings")],
      "header",
    );

    expect(groups.map((group) => group.key)).toEqual([
      "example/sidebar/main",
      "example/sidebar/settings",
    ]);
  });

  it("groups only the requested section", () => {
    const groups = groupPluginSidebarItems([installed("host-a")], "footer");

    expect(groups.map((group) => group.key)).toEqual(["example/sidebar-footer/status"]);
  });
});

describe("selectPluginSidebarTarget", () => {
  function hostsOf(section: "header" | "footer", pluginId: string) {
    const plugins = ["host-a", "host-b"].map((serverId) => installed(serverId, "main", pluginId));
    return groupPluginSidebarItems(plugins, section).map(
      (group) => selectPluginSidebarTarget(group, null).plugin.serverId,
    );
  }

  it("prefers the current route's host", () => {
    const [group] = groupPluginSidebarItems([installed("host-a"), installed("host-b")], "footer");
    expect(selectPluginSidebarTarget(group!, "host-b").plugin.serverId).toBe("host-b");
  });

  it("carries the host picked on any of a plugin's screens to all its items", () => {
    expect(hostsOf("header", "screens")).toEqual(["host-a"]);
    rememberPluginContributionHost(pluginScreensHostKey("screens"), "host-b");
    expect(hostsOf("header", "screens")).toEqual(["host-b"]);
    expect(hostsOf("footer", "screens")).toEqual(["host-b"]);
    expect(hostsOf("footer", "other")).toEqual(["host-a"]);
  });
});
