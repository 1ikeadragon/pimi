// Pimi. Apache-2.0.
import { useCallback, useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DictationOverlay } from "@/components/dictation-controls";
import { Button } from "@/components/ui/button";
import { ScrollView } from "@/components/ui/scroll-view";
import { getDesktopHost } from "@/desktop/host";
import { useDictation } from "@/hooks/use-dictation";
import { useIsDictationReady } from "@/hooks/use-is-dictation-ready";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  useHostRuntimeAgentDirectoryStatus,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";

const ISLAND_DATASET = { pimiDictationIsland: "" };

export default function TaskDictation() {
  const bridge = getDesktopHost()?.taskDictation;
  const serverId = useLocalDaemonServerId() ?? "";
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const agentDirectoryStatus = useHostRuntimeAgentDirectoryStatus(serverId);
  const ready = useIsDictationReady({ serverId, isConnected, agentDirectoryStatus });
  const started = useRef(false);
  const voice = useDictation({
    client: bridge ? client : null,
    canStart: () => Boolean(bridge && ready),
    onTranscript: (text) => bridge?.complete(text),
    enableDuration: true,
  });

  const { startDictation, cancelDictation, discardFailedDictation } = voice;
  const close = useCallback(() => bridge?.complete(null), [bridge]);
  const cancel = useCallback(async () => {
    await cancelDictation();
    close();
  }, [cancelDictation, close]);
  const discard = useCallback(() => {
    discardFailedDictation();
    close();
  }, [discardFailedDictation, close]);

  useEffect(() => {
    if (!bridge || !ready || started.current) return;
    started.current = true;
    void startDictation();
  }, [bridge, ready, startDictation]);
  useEffect(() => {
    if (!bridge || typeof window === "undefined") return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") void cancel();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [bridge, cancel]);

  if (!bridge) return null;
  const showControls = voice.isRecording || voice.isProcessing || voice.status === "failed";
  let guidance = "Getting the microphone ready…";
  if (isConnected && !ready) guidance = "Enable dictation in Settings → Voice.";
  if (ready && !voice.error) guidance = "Dictate into your brief.";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View dataSet={ISLAND_DATASET} style={styles.island}>
        {showControls ? (
          <DictationOverlay
            transparent
            compact
            volume={voice.volume}
            duration={voice.duration}
            isRecording={voice.isRecording}
            isProcessing={voice.isProcessing}
            status={voice.status}
            errorText={voice.error ?? undefined}
            onCancel={cancel}
            onAccept={voice.confirmDictation}
            onRetry={voice.retryFailedDictation}
            onDiscard={discard}
          />
        ) : (
          <View style={styles.waiting}>
            <Text accessibilityLiveRegion="polite" style={styles.description}>
              {voice.error ?? guidance}
            </Text>
            <View style={styles.actions}>
              <Button variant="ghost" onPress={cancel}>
                Cancel
              </Button>
              {ready && voice.error ? (
                <Button variant="secondary" onPress={startDictation}>
                  Try again
                </Button>
              ) : null}
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 4,
  },
  waiting: {
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  island: { width: "100%", alignItems: "center" },
  description: { flex: 1, fontSize: 13, color: theme.colors.foregroundMuted },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
}));
