import { createPlayAudio, type AudioEngine } from "@/audio";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { createPluginHosts } from "./hosts";
import { router } from "expo-router";
import type { PluginClientOpenPanelOptions, PluginNavigation } from "@pimi/plugin/client";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { subscribePluginRpc } from "@pimi/plugin/client/host";
import {
  createPluginAgentActionContext,
  createPluginCapabilities,
  createPluginWorkspaceActionContext,
} from "./actions";
import { createPluginClientStateSource } from "./client-state/source";
import type { PluginClientRuntime } from "./evaluate";
import { createPluginNavigation } from "./navigation";
import { pluginButtonStore } from "./buttons";
import { getPluginComposerBridge } from "./composer/api";
import { parsePluginOpenScreenInput } from "./surface-contribution";
import type { InstalledPlugin } from "./types";

export function createPluginClientRuntime(
  installation: InstalledPlugin,
  audio: Pick<AudioEngine, "play">,
): PluginClientRuntime {
  const state = createPluginClientStateSource(installation.serverId);
  const capabilities = createPluginCapabilities(
    installation,
    createPluginNavigation({ serverId: installation.serverId, workspaceId: null }),
  );
  return {
    ...capabilities,
    i18n: installation.i18n,
    composer: getPluginComposerBridge(installation).api,
    playAudio: createPlayAudio(audio, installation.lifetime.signal),
    hosts: createPluginHosts(getHostRuntimeStore(), installation.lifetime.signal),
    addComposerPill(contribution) {
      return pluginButtonStore.addComposerPill(installation, contribution);
    },
    addHeaderButton(contribution) {
      return pluginButtonStore.addHeaderButton(installation, contribution);
    },
    openPanel(panelId, options) {
      openClientPanel({ installation, state, panelId, options });
    },
    navigation: createClientNavigation(installation, state),
    storage: installation.storage,
    subscribe: (contract, input, onEvent, options) =>
      subscribePluginRpc(contract, installation.subscribe, input, onEvent, options),
  };
}

function openClientPanel(input: {
  installation: InstalledPlugin;
  state: ReturnType<typeof createPluginClientStateSource>;
  panelId: string;
  options: PluginClientOpenPanelOptions;
}): void {
  const { installation, state, panelId, options } = input;
  const workspaceId = options.workspaceId.trim();
  const agentId = options.agentId?.trim();
  const navigation = createPluginNavigation({ serverId: installation.serverId, workspaceId });
  const action = agentId
    ? createPluginAgentActionContext({
        plugin: installation,
        navigation,
        state,
        workspaceId,
        agentId,
      })
    : createPluginWorkspaceActionContext({
        plugin: installation,
        navigation,
        state,
        workspaceId,
      });
  if (!action) throw new Error("Plugin panel context is unavailable");
  action.openPanel(panelId, { location: options.location });
}

function createClientNavigation(
  installation: InstalledPlugin,
  state: ReturnType<typeof createPluginClientStateSource>,
): PluginNavigation {
  const home = createPluginNavigation({ serverId: installation.serverId, workspaceId: null });
  return {
    openWorkspace: ({ workspaceId, serverId }) =>
      void navigateToWorkspace({ serverId: serverId ?? installation.serverId, workspaceId }),
    openAgent: ({ agentId, serverId }) =>
      void navigateToAgent({ serverId: serverId ?? installation.serverId, agentId }),
    openFile: ({ workspaceId, path, line, serverId }) =>
      void navigateToWorkspace({
        serverId: serverId ?? installation.serverId,
        workspaceId,
        target: {
          kind: "file",
          path,
          ...(line !== undefined ? { lineStart: line, lineEnd: line } : {}),
        },
      }),
    openDiff: ({ workspaceId, path, serverId }) =>
      void navigateToWorkspace({
        serverId: serverId ?? installation.serverId,
        workspaceId,
        target: { kind: "working_diff", ...(path !== undefined ? { focusPath: path } : {}) },
      }),
    openScreen(input) {
      const { screenId, params } = parsePluginOpenScreenInput(installation, input);
      home.openSurface(installation.id, screenId, params);
    },
    openSettings(id) {
      if (!installation.settingsScreens.some((screen) => screen.id === id)) {
        throw new Error(`Plugin settings screen is unavailable: ${id}`);
      }
      home.openSettings(installation.id, id);
    },
    openPanel: (panelId, options) => openClientPanel({ installation, state, panelId, options }),
    back() {
      if (router.canGoBack()) router.back();
      else router.replace("/");
    },
  };
}
