import { PluginTranslationRuntime } from "@pimi/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import {
  currentPluginScreen,
  getPluginSurfaceContributionServerIds,
  parsePluginOpenScreenInput,
  resolvePluginScreenTitle,
  resolvePluginSurfaceContribution,
  resolvePluginSurfacePlaceholder,
} from "./surface-contribution";

it("shows loading instead of unavailable while the host catalog is pending", () => {
  expect(
    resolvePluginSurfacePlaceholder({ connectionStatus: "online", catalogStatus: "loading" }),
  ).toBe("loading");
});

it.each([
  ["online", "ready", "unavailable"],
  ["online", "error", "error"],
  ["connecting", "ready", "loading"],
  ["offline", "loading", "offline"],
  ["error", "loading", "offline"],
] as const)("shows %s host with %s catalog as %s", (connectionStatus, catalogStatus, expected) => {
  expect(resolvePluginSurfacePlaceholder({ connectionStatus, catalogStatus })).toBe(expected);
});

function installation(serverId: string, surfaces: string[], pluginId = "review"): InstalledPlugin {
  return {
    id: pluginId,
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
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: surfaces.map((id) => ({ id, title: id, Component: () => null })),
    sidebarItems: { header: [], footer: [] },
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

describe("plugin surface contribution identity", () => {
  const installations = [
    installation("host-v1", ["overview", "surface-v1"]),
    installation("host-v2", ["overview", "surface-v2"]),
    installation("same-surface", ["overview"]),
    installation("other-contribution", ["surface-v1"]),
    installation("other-plugin", ["overview", "surface-v1"], "other"),
  ];

  it("resolves a surface by its identity", () => {
    const identity = { kind: "surface", id: "overview" } as const;
    const resolved = resolvePluginSurfaceContribution(installations[0] ?? null, identity);

    expect(resolved?.id).toBe("overview");
    expect(getPluginSurfaceContributionServerIds(installations, "review", identity)).toEqual([
      "host-v1",
      "host-v2",
      "same-surface",
    ]);
  });

  it("resolves null for a missing surface", () => {
    expect(
      resolvePluginSurfaceContribution(installations[2] ?? null, {
        kind: "surface",
        id: "missing",
      }),
    ).toBeNull();
  });
});

describe("currentPluginScreen", () => {
  const plugin = installation("local", ["overview", "details"]);

  it("reads the open screen and its params from the route on the installation's host", () => {
    expect(
      currentPluginScreen(plugin, "/h/local/plugin/review/surface/overview", {
        serverId: "local",
        pluginId: "review",
        contributionKind: "surface",
        contributionId: "overview",
        "param.botId": "bot-2",
      }),
    ).toEqual({ screenId: "overview", params: { botId: "bot-2" } });
  });

  it("is null on another host, another plugin, or a missing screen", () => {
    expect(currentPluginScreen(plugin, "/h/remote/plugin/review/surface/overview", {})).toBeNull();
    expect(currentPluginScreen(plugin, "/h/local/plugin/other/surface/overview", {})).toBeNull();
    expect(currentPluginScreen(plugin, "/h/local/plugin/review/surface/missing", {})).toBeNull();
    expect(currentPluginScreen(plugin, "/h/local/workspace/abc", {})).toBeNull();
  });
});

describe("parsePluginOpenScreenInput", () => {
  const plugin = installation("local", ["bot"]);

  it("accepts a registered screen with or without string params, under any key", () => {
    expect(parsePluginOpenScreenInput(plugin, { screenId: "bot" })).toEqual({
      screenId: "bot",
      params: {},
    });
    expect(parsePluginOpenScreenInput(plugin, { screenId: "bot", params: { botId: "2" } })).toEqual(
      { screenId: "bot", params: { botId: "2" } },
    );
    expect(
      parsePluginOpenScreenInput(plugin, { screenId: "bot", params: { serverId: "x" } }),
    ).toEqual({ screenId: "bot", params: { serverId: "x" } });
  });

  it("throws on a bare id, an unknown screen, or params that are not strings", () => {
    expect(() => parsePluginOpenScreenInput(plugin, "bot")).toThrow("{ screenId, params? }");
    expect(() => parsePluginOpenScreenInput(plugin, { screenId: "missing" })).toThrow(
      "unavailable: missing",
    );
    expect(() =>
      parsePluginOpenScreenInput(plugin, { screenId: "bot", params: { botId: 2 } }),
    ).toThrow("botId must be a string");
    expect(() => parsePluginOpenScreenInput(plugin, { screenId: "bot", params: ["2"] })).toThrow(
      "must be an object of strings",
    );
  });
});

describe("resolvePluginScreenTitle", () => {
  const resolve = new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} })
    .resolve;
  const Component = () => null;
  const botNames: Record<string, string> = { "bot-1": "Bot 1", "bot-2": "Bot 2" };
  const bot = {
    id: "bot",
    title: (params: Record<string, string>) => botNames[params.botId] ?? "",
    Component,
  };

  it("uses a string title as is", () => {
    expect(
      resolvePluginScreenTitle({ id: "deploys", title: "Deploys", Component }, {}, resolve),
    ).toBe("Deploys");
  });

  it("derives a function title from the params it is given", () => {
    expect(resolvePluginScreenTitle(bot, { botId: "bot-2" }, resolve)).toBe("Bot 2");
    expect(resolvePluginScreenTitle(bot, { botId: "bot-1" }, resolve)).toBe("Bot 1");
  });

  it("falls back to the screen id when the function returns empty or throws", () => {
    expect(resolvePluginScreenTitle(bot, { botId: "missing" }, resolve)).toBe("bot");
    const throwing = {
      id: "bot",
      title: () => {
        throw new Error("no bots loaded");
      },
      Component,
    };
    expect(resolvePluginScreenTitle(throwing, {}, resolve)).toBe("bot");
  });
});
