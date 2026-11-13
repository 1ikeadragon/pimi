import { defineSettingsPage } from "@/settings-index/define";

export const hostSettings = defineSettingsPage(
  { kind: "host", section: "host" },
  ({ t, isDesktopApp }) => [
    {
      id: "host.restart",
      title: t("settings.host.daemon.restart.title"),
      keywords: ["daemon", "reload", "reboot", "stop", "start", "server"],
    },
    isDesktopApp
      ? {
          id: "host.uninstall",
          title: t("settings.host.remoteDaemon.uninstall.title"),
          keywords: ["ssh", "remote", "remove", "delete", "cleanup", "daemon", "dev machine"],
        }
      : null,
  ],
);

export const hostPairDeviceSettings = defineSettingsPage(
  { kind: "host", section: "pair-device" },
  ({ t }) => [
    {
      id: "pair-device.pair",
      title: t("settings.host.pairDevices.rowTitle"),
      keywords: ["phone", "mobile", "qr code", "link", "connect", "app"],
    },
  ],
);

export const hostAgentsSettings = defineSettingsPage(
  { kind: "host", section: "agents" },
  ({ t }) => [
    {
      id: "agents.pimiTools",
      title: t("settings.host.orchestration.enableTools.title"),
      keywords: ["mcp", "orchestration", "subagents", "tools", "inject"],
    },
    {
      id: "agents.systemPrompt",
      title: t("settings.host.orchestration.systemPrompt.title"),
      keywords: ["instructions", "prompt", "append", "rules", "claude.md"],
    },
    {
      id: "agents.resumeOnStartup",
      title: t("settings.host.agents.resumeOnStartup.title"),
      keywords: ["restart", "recovery", "resume", "startup", "running agents"],
    },
    {
      id: "agents.idleCleanup",
      title: t("settings.host.agents.idleRuntimeCleanup.title"),
      keywords: ["idle", "memory", "timeout", "stop", "processes", "runtime"],
    },
  ],
);

export const hostWorkspacesSettings = defineSettingsPage(
  { kind: "host", section: "workspaces" },
  () => [
    {
      id: "workspaces.autoArchive",
      title: "Archive chats after their PR merges",
      keywords: ["chat", "pull request", "merge", "cleanup", "worktree", "automatic"],
    },
  ],
);

export const hostTerminalsSettings = defineSettingsPage(
  { kind: "host", section: "terminals" },
  () => [
    {
      id: "terminals.agentHooks",
      title: "Enable terminal agent hooks",
      keywords: ["notifications", "status", "claude", "codex", "config files", "install hooks"],
    },
  ],
);

export const hostConnectionsSettings = defineSettingsPage(
  { kind: "host", section: "connections" },
  ({ t, isDesktopApp }) => [
    isDesktopApp
      ? {
          id: "connections.remoteSsh",
          title: t("remoteDev.title"),
          keywords: [
            "ssh",
            "remote",
            "dev machine",
            "devbox",
            "vps",
            "server",
            "linux",
            "vscode remote",
            "install daemon",
            "connect",
          ],
        }
      : null,
  ],
);
