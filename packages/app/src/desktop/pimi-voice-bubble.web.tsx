// Pimi. Apache-2.0.
import { router, usePathname } from "expo-router";
import { CircleAlert, Mic, Square, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View, type ViewStyle } from "react-native";
import { PimiMascot } from "@/components/icons/pimi-mascot";
import { StyleSheet } from "react-native-unistyles";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { useCommandCenterContributions } from "@/command-center/provider";
import { DensityIcon } from "@/components/ui/density-icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VolumeMeter } from "@/components/volume-meter";
import { useVoiceOptional } from "@/contexts/voice-context";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import { usePimiWorkspaceSection } from "@/desktop/pimi-console-content";
import { parsePimiVoiceCommand } from "@/desktop/pimi-voice-command";
import { usePimiVoiceHistory } from "@/desktop/pimi-voice-history";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { usePimiVoiceCue } from "@/desktop/use-pimi-voice-cue.web";
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
  buildAutomationsRoute,
  buildSessionsRoute,
  buildSettingsRoute,
} from "@/utils/host-routes";
import { getVoiceReadinessState } from "@/utils/server-info-capabilities";
import {
  isExplicitVoiceChatRequest,
  PIMI_VOICE_COMMAND_LIMIT,
  type PimiVoiceBubbleState,
  PimiVoiceNavigation,
  type PimiDestination,
  type PimiVoiceEffect,
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
  finishing: "Transcribing…",
  hearing: "Hearing you…",
  listening: "Listening",
};
const BUSY = "Still working on your last command. Say this again when it finishes.";
const VOICE_OFF = { selected: false };
const VOICE_ON = { selected: true };
const WORKING = "Working…";
const BUBBLE_POP_ANIMATION = "pimi-voice-bubble-pop";
const TYPING_DOT_ANIMATION = "pimi-voice-typing-dot";
// The reply follows the transcript by a beat, so the exchange reads as two turns.
const REPLY_DELAY_MS = 110;
const TYPING_DOT_STAGGER_MS = 160;
// Bubbles float over arbitrary app content with no panel behind them.
const BUBBLE_SHADOW = "0 1px 2px #0000001a, 0 8px 24px #00000024";

// A bubble grows out of its sender's corner and settles after a small overshoot. With reduced
// motion the keyframes are never defined, so bubbles and typing dots appear at rest.
function ensureVoiceBubbleKeyframes() {
  if (typeof document === "undefined" || document.getElementById(BUBBLE_POP_ANIMATION)) return;
  const style = document.createElement("style");
  style.id = BUBBLE_POP_ANIMATION;
  style.textContent = `@media (prefers-reduced-motion: no-preference) {
  @keyframes ${BUBBLE_POP_ANIMATION} {
    0% { opacity: 0; transform: translateY(12px) scale(0.6); }
    55% { opacity: 1; transform: translateY(-2px) scale(1.035); }
    78% { transform: translateY(0) scale(0.99); }
    100% { opacity: 1; transform: none; }
  }
  @keyframes ${TYPING_DOT_ANIMATION} {
    0%, 60%, 100% { opacity: 0.35; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-3px); }
  }
}`;
  document.head.appendChild(style);
}
ensureVoiceBubbleKeyframes();

// The CSS animation props are not part of ViewStyle without the generated expo-env.d.ts.
function bubblePop(origin: "bottom right" | "bottom left", delayMs: number): ViewStyle {
  return {
    flexShrink: 1,
    transformOrigin: origin,
    animationName: BUBBLE_POP_ANIMATION,
    animationDuration: "420ms",
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    animationDelay: `${delayMs}ms`,
    animationFillMode: "backwards",
  } as unknown as ViewStyle;
}
const OUTGOING_POP = bubblePop("bottom right", 0);
const INCOMING_POP = bubblePop("bottom left", REPLY_DELAY_MS);
const TYPING_DOTS = ["first", "second", "third"].map((id, index) => ({
  id,
  motion: {
    animationName: TYPING_DOT_ANIMATION,
    animationDuration: "1200ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
    animationDelay: `${index * TYPING_DOT_STAGGER_MS}ms`,
  } as unknown as ViewStyle,
}));

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
        pathname === buildAutomationsRoute() ||
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
      router.navigate(buildAutomationsRoute());
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

function VoiceReceipt({
  receipt,
  dismiss,
}: {
  receipt: NonNullable<PimiVoiceBubbleState["receipt"]>;
  dismiss: () => void;
}) {
  return (
    <View style={styles.receipt} testID="ask-pimi-receipt">
      <ScrollView style={styles.receiptContent} contentContainerStyle={styles.receiptMessages}>
        <View style={styles.outgoing}>
          <View style={OUTGOING_POP}>
            <View style={styles.transcriptBubble}>
              <Text selectable style={styles.transcript}>
                {receipt.transcript}
              </Text>
            </View>
          </View>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={X}
            onPress={dismiss}
            accessibilityLabel="Dismiss Ask Pimi receipt"
          />
        </View>
        {/* Keyed by state so the result pops in where the typing bubble was. */}
        <View key={receipt.state} style={styles.incoming} accessibilityLiveRegion="polite">
          <View style={INCOMING_POP}>
            {receipt.state === "working" ? (
              <TypingBubble status={receipt.message === WORKING ? "" : receipt.message} />
            ) : (
              <View style={styles.receiptResult}>
                {receipt.state === "error" ? (
                  <DensityIcon icon={CircleAlert} size="sm" color="statusDanger" />
                ) : null}
                <Text selectable style={styles.reply}>
                  {receipt.message}
                </Text>
              </View>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function TypingBubble({ status }: { status: string }) {
  return (
    <View
      style={styles.typingBubble}
      accessibilityRole="progressbar"
      accessibilityLabel={status || WORKING}
    >
      {TYPING_DOTS.map(({ id, motion }) => (
        <View key={id} style={motion}>
          <View style={styles.typingDot} />
        </View>
      ))}
      {status ? (
        <Text style={styles.typingStatus} numberOfLines={1} testID="ask-pimi-progress">
          {status}
        </Text>
      ) : null}
    </View>
  );
}

function VoiceFeedback({
  status,
  active,
  level,
  receipt,
  receiptId,
  dismissReceipt,
}: {
  status: string;
  active: boolean;
  level: number;
  receipt: PimiVoiceBubbleState["receipt"];
  receiptId: string | null;
  dismissReceipt: () => void;
}) {
  return (
    <View style={styles.feedback}>
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
      {receipt ? <VoiceReceipt key={receiptId} receipt={receipt} dismiss={dismissReceipt} /> : null}
    </View>
  );
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
  const { settings: desktopSettings } = useDesktopSettings();
  const { playCue, isPlayingCue } = usePimiVoiceCue(desktopSettings.notifications.playSound);
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
  const [progress, setProgress] = useState("");
  useEffect(() => bridge.onStatus?.(setProgress), [bridge]);
  const commandRunning = useRef(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const receiptEntry = usePimiVoiceHistory((state) =>
    state.entries.find(({ id }) => id === receiptId),
  );
  const dismissReceipt = useCallback(() => setReceiptId(null), []);
  const receipt = useMemo((): PimiVoiceBubbleState["receipt"] => {
    if (!receiptEntry) return undefined;
    if (!receiptEntry.outcome) {
      return {
        transcript: receiptEntry.transcript,
        message: progress ? `${progress}…` : WORKING,
        state: "working",
      };
    }
    return {
      transcript: receiptEntry.transcript,
      message: receiptEntry.outcome.message,
      state: receiptEntry.outcome.failed ? "error" : "finished",
    };
  }, [progress, receiptEntry]);
  const listener = usePimiVoiceListener({
    client: connected ? client : null,
    unavailable,
    isPlayingCue,
    onTranscript: (transcript) => {
      const { record, finish } = usePimiVoiceHistory.getState();
      const recordId = record(transcript);
      playCue();
      const complete = (message: string, failed = false) => finish(recordId, { message, failed });
      const command = parsePimiVoiceCommand(transcript);
      if (command?.action === "stop") {
        listener.stop();
        setReceiptId(recordId);
        complete("Microphone off");
        return;
      }
      if (commandRunning.current) {
        listener.setMessage(BUSY);
        complete(BUSY, true);
        return;
      }
      setReceiptId(recordId);
      const agentId =
        useSessionStore.getState().sessions[localServerId]?.focusedAgentId ?? undefined;
      const navigationContext = { host, localServerId, selection, pathname, agentId };
      if (command) {
        const parsed = PimiVoiceNavigation.safeParse(command);
        try {
          if (parsed.success) complete(applyVoiceCommand(parsed.data, navigationContext) ?? "Done");
          else complete("Try a shorter command.", true);
        } catch {
          complete("Couldn’t finish that command.", true);
        }
        return;
      }
      const wantsChat = isExplicitVoiceChatRequest(transcript);
      const commands = contributions
        .filter(({ id }) => wantsChat || !id.endsWith("tab:new-agent"))
        .slice(0, PIMI_VOICE_COMMAND_LIMIT);
      commandRunning.current = true;
      setProgress("");
      void (async () => {
        try {
          const result = await bridge.runCommand({
            transcript,
            agentId,
            workspaceId: selection?.serverId === localServerId ? selection.workspaceId : undefined,
            commands: commands.map((entry) => commandTitle(entry).slice(0, 160)),
          });
          if (result.ignored) {
            // Background speech asked for nothing. Keep it in history and show no receipt.
            complete("No request heard");
            setReceiptId((current) => (current === recordId ? null : current));
            return;
          }
          const applyEffect = async (effect: PimiVoiceEffect) => {
            if (effect.destination) host.showPimiWorkspace?.(effect.destination);
            if (effect.chat && wantsChat) {
              host.dismissPimiWorkspace?.();
              const { serverId, workspaceId, agentId: id } = effect.chat;
              navigateToWorkspace({
                serverId,
                workspaceId,
                target: { kind: "agent", agentId: id },
              });
            }
            const target =
              effect.navigation?.action === "new-chat" && !wantsChat
                ? undefined
                : effect.navigation;
            if (target?.action === "registered-commands") {
              return runRegisteredCommands(target.indexes, commands, () => currentCommands.current);
            }
            const opened = target && applyVoiceCommand(target, navigationContext);
            // Ask Pimi's own reply already says what it opened.
            return result.message ? undefined : opened;
          };
          const notes = [];
          for (const effect of [result, ...(result.effects ?? [])]) {
            notes.push(await applyEffect(effect));
          }
          complete([result.message, ...notes].filter(Boolean).join(" · ") || "Done", result.failed);
        } catch (error) {
          const message = error instanceof Error ? error.message.split("Error: ").at(-1) : "";
          complete(message || "Couldn’t finish that command.", true);
        } finally {
          commandRunning.current = false;
          setProgress("");
          listener.setMessage((current) => (current === BUSY ? "" : current));
        }
      })();
    },
  });

  const { phase, message, level, stop, toggle } = listener;
  const finishing = phase === "finishing";
  const active = phase !== "off" && !finishing;
  const status = message || PHASE_STATUS[phase];
  let label = active ? "Pimi · Stop listening" : "Pimi · Start listening";
  if (finishing) label = "Pimi · Finishing transcript";
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
  useEffect(() => bridge.onDismissReceipt?.(dismissReceipt), [bridge, dismissReceipt]);
  useEffect(
    () =>
      bridge.publish({
        visible,
        active: visible && active,
        status: visible ? status.slice(0, 240) : "",
        level: visible ? workspaceLevel : 0,
        receipt: visible ? receipt : undefined,
      }),
    [active, bridge, receipt, status, visible, workspaceLevel],
  );

  if (!visible || section || (!enabled && !active && !status && !receipt)) return null;
  return (
    <View pointerEvents="box-none" style={[styles.dock, aboveComposer && styles.aboveComposer]}>
      <VoiceFeedback
        status={status}
        active={active}
        level={level}
        receipt={receipt}
        receiptId={receiptId}
        dismissReceipt={dismissReceipt}
      />
      <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          accessibilityLabel={label}
          accessibilityRole="button"
          accessibilityState={active ? VOICE_ON : VOICE_OFF}
          disabled={finishing}
          testID="pimi-voice-toggle"
          onPress={toggle}
          style={styles.button}
        >
          <View style={styles.dog} accessible={false}>
            <PimiMascot size={30} />
          </View>
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
    left: 16,
    bottom: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
    zIndex: 12,
  },
  aboveComposer: { bottom: 140 },
  feedback: { alignItems: "flex-end", flexShrink: 1, gap: 6 },
  receipt: {
    width: 340,
    maxWidth: "100%",
  },
  receiptContent: { maxHeight: 196 },
  // The scroll view clips, so the padding leaves room for bubble shadows and the pop overshoot.
  receiptMessages: { gap: theme.spacing[2], padding: theme.spacing[2] },
  outgoing: { flexDirection: "row", alignItems: "flex-start", justifyContent: "flex-end" },
  incoming: { flexDirection: "row", justifyContent: "flex-start", paddingRight: theme.spacing[8] },
  transcriptBubble: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.xl,
    borderBottomRightRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    boxShadow: BUBBLE_SHADOW,
  },
  transcript: { color: theme.colors.accentForeground, fontSize: theme.fontSize.base },
  receiptResult: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.xl,
    borderBottomLeftRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    boxShadow: BUBBLE_SHADOW,
  },
  reply: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flexShrink: 1 },
  typingBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.xl,
    borderBottomLeftRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    boxShadow: BUBBLE_SHADOW,
  },
  typingStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginLeft: theme.spacing[1],
    flexShrink: 1,
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
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
    flexShrink: 0,
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
