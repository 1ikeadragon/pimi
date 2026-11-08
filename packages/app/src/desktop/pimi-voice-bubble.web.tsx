// Pimi addition to the Paseo fork. Apache-2.0.
import { router } from "expo-router";
import { Mic, Square } from "lucide-react-native";
import { useEffect, useMemo } from "react";
import { Image, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DensityIcon } from "@/components/ui/density-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VolumeMeter } from "@/components/volume-meter";
import { useVoiceOptional } from "@/contexts/voice-context";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import { parsePimiVoiceCommand } from "@/desktop/pimi-voice-command";
import { usePimiVoiceListener } from "@/desktop/use-pimi-voice-listener.web";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
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
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { getVoiceReadinessState } from "@/utils/server-info-capabilities";
import { PimiNewTaskDestination } from "@getpaseo/protocol/pimi-task";

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

function applyVoiceCommand(
  command: NonNullable<ReturnType<typeof parsePimiVoiceCommand>>,
  {
    host,
    localServerId,
    selection,
    stop,
    setMessage,
  }: {
    host: DesktopHostBridge;
    localServerId: string;
    selection: ReturnType<typeof useActiveWorkspaceSelection>;
    stop: () => void;
    setMessage: (message: string) => void;
  },
) {
  switch (command.action) {
    case "stop":
      stop();
      setMessage("Microphone off");
      return;
    case "show":
      setMessage(`Got it · Opening ${command.label}`);
      if (command.destination === "chat") host.dismissPimiWorkspace?.();
      else host.showPimiWorkspace?.(command.destination);
      return;
    case "new-task": {
      const result = PimiNewTaskDestination.safeParse({
        view: "new-task",
        title: command.title,
        brief: command.brief,
      });
      if (!result.success) {
        setMessage("Try a shorter task title or brief.");
        return;
      }
      setMessage("Got it · Opening task draft");
      host.showPimiWorkspace?.(result.data);
      return;
    }
    case "new-chat": {
      const draftId = generateDraftId();
      const draftKey = selection
        ? buildDraftStoreKey({ serverId: selection.serverId, agentId: "", draftId })
        : buildNewWorkspaceDraftKey(draftId);
      if (command.text) useDraftStore.getState().editDraftText({ draftKey, text: command.text });
      setMessage("Got it · Opening chat draft");
      host.dismissPimiWorkspace?.();
      if (selection) {
        navigateToWorkspace({ ...selection, target: { kind: "draft", draftId } });
      } else {
        router.navigate(buildNewWorkspaceRoute({ serverId: localServerId, draftId }));
      }
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
  const localServerId = useLocalDaemonServerId() ?? "";
  const client = useHostRuntimeClient(localServerId);
  const connected = useHostRuntimeIsConnected(localServerId);
  const selection = useActiveWorkspaceSelection();
  const unavailable = useCommandVoiceUnavailable(localServerId);
  const listener = usePimiVoiceListener({
    client: connected ? client : null,
    unavailable,
    onTranscript: (transcript) => {
      const command = parsePimiVoiceCommand(transcript);
      if (!command) {
        listener.setMessage("Try “Open a new chat” or “Start a new task”.");
        return;
      }
      applyVoiceCommand(command, {
        host,
        localServerId,
        selection,
        stop: listener.stop,
        setMessage: listener.setMessage,
      });
    },
  });

  const { phase, message, level, setMessage, stop, toggle } = listener;
  const active = phase !== "off";
  const status = message || PHASE_STATUS[phase];
  const label = active ? "Pimi · Stop listening" : "Pimi · Start listening";
  const workspaceLevel = section ? level : 0;
  const badgeStyle = useMemo(() => [styles.badge, active && styles.activeBadge], [active]);

  useEffect(() => bridge.onToggle(toggle), [bridge, toggle]);
  useEffect(() => bridge.onPause(() => stop()), [bridge, stop]);
  useEffect(
    () => bridge.publish({ active, status: status.slice(0, 240), level: workspaceLevel }),
    [active, bridge, status, workspaceLevel],
  );
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 6500);
    return () => window.clearTimeout(timer);
  }, [setMessage, message]);

  if (section || (!enabled && !active && !status)) return null;
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
