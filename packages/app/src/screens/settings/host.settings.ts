import { defineSettingsPage } from "@/settings-index/define";
import { BROWSER_TOOLS_TITLE } from "./browser-tools-config";

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

export const hostConnectionSettings = defineSettingsPage(
  { kind: "host", section: "host" },
  ({ t }) => [
    {
      id: "host.appearance",
      title: t("settings.host.appearance.title"),
      keywords: ["name", "rename", "color", "badge", "label", "icon"],
    },
    {
      id: "host.connections",
      title: t("settings.host.connections.title"),
      keywords: ["address", "relay", "direct", "tcp", "timeout", "endpoint"],
    },
    {
      id: "host.remove",
      title: t("settings.host.daemon.remove.title"),
      keywords: ["delete", "forget", "danger"],
    },
  ],
);

export const hostPairDeviceSettings = defineSettingsPage(
  { kind: "host", section: "host" },
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
      keywords: ["instructions", "prompt", "append", "rules", "claude.md", "agents.md", "layers"],
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
    {
      id: "agents.skills",
      title: t("settings.host.skills.title"),
      keywords: ["skills", "orchestration", "teach", "install skills"],
    },
    {
      id: "agents.profiles",
      title: t("settings.host.agents.profiles.title"),
      keywords: ["profiles", "defaults", "model", "provider", "mode", "saved"],
    },
  ],
);

export const hostWorkspacesSettings = defineSettingsPage(
  { kind: "host", section: "agents" },
  ({ t }) => [
    {
      id: "workspaces.autoArchive",
      title: t("settings.host.autoArchive.title"),
      keywords: ["chat", "pull request", "merge", "cleanup", "worktree", "automatic"],
    },
  ],
);

export const hostTerminalsSettings = defineSettingsPage(
  { kind: "host", section: "agents" },
  ({ t }) => [
    {
      id: "terminals.agentHooks",
      title: t("settings.host.terminalAgentHooks.title"),
      keywords: ["notifications", "status", "claude", "codex", "config files", "install hooks"],
    },
  ],
);

export const hostConnectionsSettings = defineSettingsPage(
  { kind: "host", section: "host" },
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

export const hostTrustSettings = defineSettingsPage(
  { kind: "host", section: "trust" },
  ({ t, isDesktopApp }) => [
    {
      id: "trust.browserTools",
      title: BROWSER_TOOLS_TITLE,
      keywords: ["browser", "tabs", "logged in", "cookies", "control", "agents"],
    },
    {
      id: "trust.supplyChain",
      title: t("settings.supplyChain.updates"),
      keywords: [
        "package updates",
        "supply chain",
        "pin",
        "latest",
        "npx",
        "uvx",
        "mcp",
        "updates",
      ],
    },
    isDesktopApp
      ? {
          id: "trust.agentAccess",
          title: t("settings.host.agentAccess.title"),
          keywords: ["agent access", "remote", "this computer", "start agents", "full access"],
        }
      : null,
  ],
);

export const hostProvidersSettings = defineSettingsPage(
  { kind: "host", section: "providers" },
  ({ t }) => [
    {
      id: "providers.limitFallback",
      title: t("settings.providers.limitFallback.title"),
      keywords: ["fallback", "limit", "rate limit", "quota", "another model", "continue"],
    },
    {
      id: "providers.harnessUpdates",
      title: t("harnessUpdates.title"),
      keywords: ["updates", "harness", "cli", "version", "upgrade"],
    },
    {
      id: "providers.addProvider",
      title: t("settings.providers.addProvider"),
      keywords: ["custom provider", "catalog", "acp", "install", "new"],
    },
  ],
);

export const hostTerminalPageSettings = defineSettingsPage(
  { kind: "host", section: "terminals" },
  ({ t }) => [
    {
      id: "terminals.profiles",
      title: t("settings.host.terminalProfiles.sectionTitle"),
      keywords: ["shell", "command", "launch", "new terminal", "zsh", "bash"],
    },
    {
      id: "terminals.languageServers",
      title: t("settings.languageServers.title"),
      keywords: ["lsp", "language server", "code intelligence", "completion", "go to definition"],
    },
  ],
);

export const hostMetadataSettings = defineSettingsPage(
  { kind: "host", section: "metadata" },
  ({ t }) => [
    {
      id: "metadata.selection",
      title: t("settings.metadataGeneration.selection"),
      keywords: ["model", "automatic", "preferred", "titles", "commit messages"],
    },
    {
      id: "metadata.actionItems",
      title: t("settings.metadataGeneration.actionItems"),
      keywords: ["todo", "tasks", "extract", "recap"],
    },
  ],
);

export const hostVoiceSettings = defineSettingsPage({ kind: "host", section: "voice" }, ({ t }) => [
  {
    id: "voice.dictation",
    title: t("settings.voice.dictation.title"),
    keywords: ["speech", "microphone", "stt", "whisper", "transcribe", "typing"],
  },
  {
    id: "voice.voiceMode",
    title: t("settings.voice.voiceMode.title"),
    keywords: ["speech", "tts", "talk", "conversation", "spoken"],
  },
]);

export const hostPluginsSettings = defineSettingsPage(
  { kind: "host", section: "plugins" },
  ({ t }) => [
    {
      id: "plugins.enabled",
      title: t("settings.plugins.globalTitle"),
      keywords: ["extensions", "mods", "turn on", "global switch"],
    },
    {
      id: "plugins.safeMode",
      title: t("settings.plugins.ui.safeModeTitle"),
      keywords: ["disable overrides", "troubleshoot", "recover", "ui"],
    },
    {
      id: "plugins.install",
      title: t("settings.plugins.install"),
      keywords: ["add", "source", "git", "npm", "directory", "owner/slug"],
    },
  ],
);

export const hostResourcesSettings = defineSettingsPage(
  { kind: "host", section: "resources" },
  ({ t }) => [
    {
      id: "resources.resolveNames",
      title: t("settings.resources.resolveNames"),
      keywords: ["dns", "hostnames", "network", "destinations"],
    },
    {
      id: "resources.saveLogs",
      title: t("settings.resources.logs"),
      keywords: ["network log", "save", "record", "requests", "traffic"],
    },
    {
      id: "resources.retention",
      title: t("settings.resources.days"),
      keywords: ["log retention", "days", "keep", "delete old logs", "cleanup"],
    },
  ],
);
