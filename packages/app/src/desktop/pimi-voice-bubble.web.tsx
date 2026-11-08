// Pimi addition to the Paseo fork. Apache-2.0.
import { router, usePathname } from "expo-router";
import { Mic, Square } from "lucide-react-native";
import { useEffect, useMemo, useRef } from "react";
import { Image, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { useCommandCenterContributions } from "@/command-center/provider";
import { DensityIcon } from "@/components/ui/density-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VolumeMeter } from "@/components/volume-meter";
import { useVoiceOptional } from "@/contexts/voice-context";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import { parsePimiVoiceCommand } from "@/desktop/pimi-voice-command";
import { usePimiVoiceListener } from "@/desktop/use-pimi-voice-listener.web";
import { useAppSettings } from "@/hooks/use-settings";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  closePimiAgentGrid,
  openPimiAgentGrid,
  PIMI_AGENT_GRID_ROUTE,
} from "@/navigation/pimi-agent-grid";
import { closePimiLibrary, openPimiLibrary, PIMI_LIBRARY_ROUTE } from "@/navigation/pimi-library";
import {
  closePimiUsage,
  openPimiUsage,
  openPimiUsageDetail,
  PIMI_USAGE_ROUTE,
} from "@/navigation/pimi-usage";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  buildDraftStoreKey,
  buildNewWorkspaceDraftKey,
  generateDraftId,
} from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import {
  buildNewWorkspaceRoute,
  buildOpenProjectRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
  buildSettingsRoute,
} from "@/utils/host-routes";
import { getVoiceReadinessState } from "@/utils/server-info-capabilities";
import {
  PIMI_VOICE_COMMAND_LIMIT,
  PimiVoiceNavigation,
  type PimiDestination,
  type PimiVoiceView,
} from "@pimi/protocol/pimi-task";

interface VoiceBubbleProps {
  enabled: boolean;
  aboveComposer: boolean;
}

export function PimiVoiceBubble(props: VoiceBubbleProps) {
  const host = getDesktopHost();
  if (!host?.pimiVoice) return null;
  return <DesktopVoiceBubble host={host} bridge={host.pimiVoice} {...props} />;
}

const PHASE_STATUS = {
  off: "",
  starting: "Starting microphone…",
  processing: "Transcribing…",
  listening: "Listening",
};

const VOICE_OFF = { selected: false };
const VOICE_ON = { selected: true };
const VOICE_DOG = { uri: "/pimi-textures/voice-dog.svg" };

const WORKSPACE_VIEWS: Partial<Record<PimiVoiceView, PimiDestination>> = {
  tasks: { view: "tasks" },
  work: { view: "worktrees" },
  review: { view: "review-home" },
  memory: { view: "memory" },
  spaces: { view: "spaces" },
};

function commandTitle(command: CommandCenterContribution): string {
  const entry = command.presentation;
  return entry.kind === "choice"
    ? entry.path.join(" → ")
    : [entry.sectionTitle, entry.title, entry.subtitle].filter(Boolean).join(" · ");
}

async function runRegisteredCommands(
  indexes: number[],
  offered: readonly CommandCenterContribution[],
  getCurrent: () => readonly CommandCenterContribution[],
) {
  const completed = [];
  for (const index of new Set(indexes)) {
    const requested = offered[index];
    const available =
      requested &&
      getCurrent().find(
        (entry) => entry.id === requested.id && commandTitle(entry) === commandTitle(requested),
      );
    if (!available) {
      completed.push("That action is no longer available.");
      break;
    }
    try {
      await available.run();
    } catch {
      completed.push(`Couldn’t run ${commandTitle(available)}.`);
      break;
    }
    completed.push(commandTitle(available));
  }
  return completed.join(" · ");
}

function openVoiceView(view: PimiVoiceView, host: DesktopHostBridge, pathname: string) {
  const destination = WORKSPACE_VIEWS[view];
  if (destination) {
    host.showPimiWorkspace?.(destination);
    return;
  }
  host.dismissPimiWorkspace?.();
  switch (view) {
    case "chat":
      if (pathname === PIMI_AGENT_GRID_ROUTE) closePimiAgentGrid();
      else if (pathname === PIMI_USAGE_ROUTE) closePimiUsage();
      else if (pathname === PIMI_LIBRARY_ROUTE) closePimiLibrary();
      else if (
        pathname === buildSchedulesRoute() ||
        pathname === buildSessionsRoute() ||
        pathname.startsWith(buildSettingsRoute())
      ) {
        if (router.canGoBack()) router.back();
        else router.replace(buildOpenProjectRoute());
      }
      break;
    case "agents":
      openPimiAgentGrid();
      break;
    case "usage":
      openPimiUsage();
      break;
    case "skills":
    case "hooks":
      openPimiLibrary(view, pathname === PIMI_LIBRARY_ROUTE);
      break;
    case "automations":
      router.navigate(buildSchedulesRoute());
      break;
    case "history":
      router.navigate(buildSessionsRoute());
      break;
    case "settings":
      router.navigate(buildSettingsRoute());
      break;
  }
}

function applyVoiceCommand(
  command: PimiVoiceNavigation,
  {
    host,
    localServerId,
    selection,
    pathname,
    agentId,
  }: {
    host: DesktopHostBridge;
    localServerId: string;
    selection: ReturnType<typeof useActiveWorkspaceSelection>;
    pathname: string;
    agentId?: string;
  },
) {
  switch (command.action) {
    case "show":
      openVoiceView(command.view, host, pathname);
      return `Opening ${command.view[0].toUpperCase() + command.view.slice(1)}`;
    case "new-space":
      host.showPimiWorkspace?.({
        view: "spaces",
        action: { kind: "draft", text: command.text },
      });
      return "Opening a Spaces card";
    case "search-spaces":
      host.showPimiWorkspace?.({
        view: "spaces",
        action: { kind: "search", query: command.query },
      });
      return "Searching Spaces";
    case "review-prs":
      host.showPimiWorkspace?.({ view: "review-prs", filter: command.filter });
      return "Opening pull requests";
    case "usage":
      openPimiUsageDetail(
        { tab: command.tab, session: command.session, agentId, serverId: localServerId },
        pathname === PIMI_USAGE_ROUTE,
      );
      return "Opening Usage";
    case "new-task":
      host.showPimiWorkspace?.({
        view: "new-task",
        title: command.title,
        brief: command.brief,
      });
      return "Opening task draft";
    case "new-chat": {
      const draftId = generateDraftId();
      const draftKey = selection
        ? buildDraftStoreKey({ serverId: selection.serverId, agentId: "", draftId })
        : buildNewWorkspaceDraftKey(draftId);
      if (command.text) useDraftStore.getState().editDraftText({ draftKey, text: command.text });
      host.dismissPimiWorkspace?.();
      if (selection) {
        navigateToWorkspace({ ...selection, target: { kind: "draft", draftId } });
      } else {
        router.navigate(buildNewWorkspaceRoute({ serverId: localServerId, draftId }));
      }
      return "Opening chat draft";
    }
  }
}

function useCommandVoiceUnavailable(localServerId: string): string | null {
  const readiness = useSessionStore((state) =>
    getVoiceReadinessState({
      serverInfo: state.sessions[localServerId]?.serverInfo,
      mode: "dictation",
    }),
  );
  const voice = useVoiceOptional();
  if (voice?.isVoiceMode || voice?.isVoiceSwitching) return "Turn off chat Voice Mode first.";
  if (readiness?.enabled === false) {
    return readiness.reason || "Enable dictation in Settings → Voice.";
  }
  return null;
}

function DesktopVoiceBubble({
  host,
  bridge,
  enabled,
  aboveComposer,
}: VoiceBubbleProps & {
  host: DesktopHostBridge;
  bridge: NonNullable<DesktopHostBridge["pimiVoice"]>;
}) {
  const section = usePimiWorkspaceSection();
  const { settings, isLoading } = useAppSettings();
  const visible = !isLoading && settings.pimiVoiceButton;
  const localServerId = useLocalDaemonServerId() ?? "";
  const client = useHostRuntimeClient(localServerId);
  const connected = useHostRuntimeIsConnected(localServerId);
  const selection = useActiveWorkspaceSelection();
  const pathname = usePathname();
  const { contributions } = useCommandCenterContributions();
  const currentCommands = useRef(contributions);
  useEffect(() => {
    currentCommands.current = contributions;
  }, [contributions]);
  const unavailable = useCommandVoiceUnavailable(localServerId);
  const commandRunning = useRef(false);
  const listener = usePimiVoiceListener({
    client: connected ? client : null,
    unavailable,
    onTranscript: (transcript) => {
      const command = parsePimiVoiceCommand(transcript);
      if (command?.action === "stop") {
        listener.stop();
        listener.setMessage("Microphone off");
        return;
      }
      if (commandRunning.current) {
        listener.setMessage("Still working on your last command.");
        return;
      }
      const agentId =
        useSessionStore.getState().sessions[localServerId]?.focusedAgentId ?? undefined;
      const navigationContext = { host, localServerId, selection, pathname, agentId };
      if (command) {
        const parsed = PimiVoiceNavigation.safeParse(command);
        listener.setMessage(
          parsed.success
            ? (applyVoiceCommand(parsed.data, navigationContext) ?? "")
            : "Try a shorter command.",
        );
        return;
      }
      const commands = contributions.slice(0, PIMI_VOICE_COMMAND_LIMIT);
      commandRunning.current = true;
      listener.setMessage("Working…");
      void (async () => {
        try {
          const result = await bridge.runCommand({
            transcript,
            agentId,
            workspaceId: selection?.serverId === localServerId ? selection.workspaceId : undefined,
            commands: commands.map((entry) => commandTitle(entry).slice(0, 160)),
          });
          if (result.destination) host.showPimiWorkspace?.(result.destination);
          if (result.chat) {
            host.dismissPimiWorkspace?.();
            const { serverId, workspaceId, agentId: id } = result.chat;
            navigateToWorkspace({ serverId, workspaceId, target: { kind: "agent", agentId: id } });
          }
          const target = result.navigation;
          const navigation =
            target?.action === "registered-commands"
              ? await runRegisteredCommands(target.indexes, commands, () => currentCommands.current)
              : target && applyVoiceCommand(target, navigationContext);
          listener.setMessage([result.message, navigation].filter(Boolean).join(" · "));
        } catch (error) {
          const message = error instanceof Error ? error.message.split("Error: ").at(-1) : "";
          listener.setMessage(message || "Couldn’t finish that command.");
        } finally {
          commandRunning.current = false;
        }
      })();
    },
  });

  const { phase, message, level, setMessage, stop, toggle } = listener;
  const active = phase !== "off";
  const status = message || PHASE_STATUS[phase];
  const label = active ? "Pimi · Stop listening" : "Pimi · Start listening";
  const workspaceLevel = section ? level : 0;
  const badgeStyle = useMemo(() => [styles.badge, active && styles.activeBadge], [active]);

  useEffect(() => {
    if (!visible) stop();
  }, [visible, stop]);
  useEffect(
    () =>
      bridge.onToggle(() => {
        if (visible) toggle();
      }),
    [bridge, toggle, visible],
  );
  useEffect(() => bridge.onPause(() => stop()), [bridge, stop]);
  useEffect(
    () =>
      bridge.publish({
        visible,
        active: visible && active,
        status: visible ? status.slice(0, 240) : "",
        level: visible ? workspaceLevel : 0,
      }),
    [active, bridge, status, visible, workspaceLevel],
  );
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 6500);
    return () => window.clearTimeout(timer);
  }, [setMessage, message]);

  if (!visible || section || (!enabled && !active && !status)) return null;
  return (
    <View pointerEvents="box-none" style={[styles.dock, aboveComposer && styles.aboveComposer]}>
      {status ? (
        <View style={styles.status}>
          {active ? (
            <View style={styles.meter}>
              <VolumeMeter
                volume={level}
                orientation="horizontal"
                variant="compact"
                isSpeaking={level > 0}
              />
            </View>
          ) : null}
          <Text style={styles.statusText} accessibilityLiveRegion="polite">
            {status}
          </Text>
        </View>
      ) : null}
      <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          accessibilityLabel={label}
          accessibilityRole="button"
          accessibilityState={active ? VOICE_ON : VOICE_OFF}
          testID="pimi-voice-toggle"
          onPress={toggle}
          style={styles.button}
        >
          <Image source={VOICE_DOG} style={styles.dog} accessible={false} />
          <View style={badgeStyle}>
            <DensityIcon
              icon={active ? Square : Mic}
              size="sm"
              sizeAdjustment={-6}
              color={active ? "accentForeground" : "foreground"}
            />
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" offset={8}>
          <Text style={styles.statusText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  dock: {
    position: "absolute",
    right: 16,
    bottom: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    zIndex: 12,
  },
  aboveComposer: { bottom: 140 },
  status: {
    maxWidth: 230,
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  statusText: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
  meter: {
    width: 19,
    height: 17,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ scale: 0.55 }],
  },
  button: {
    width: 42,
    height: 42,
    borderRadius: theme.borderRadius.full,
    borderColor: theme.colors.borderAccent,
    borderWidth: 1,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 2px 8px #00000016",
  },
  dog: { width: 30, height: 30 },
  badge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 17,
    height: 17,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.borderAccent,
    borderWidth: 1,
  },
  activeBadge: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
}));
