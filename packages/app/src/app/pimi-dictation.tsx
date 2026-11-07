// Pimi addition to the Paseo fork. Apache-2.0.
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

  if (!bridge) return null;
  const showControls = voice.isRecording || voice.isProcessing || voice.status === "failed";
  let guidance = "Waiting for the local voice service…";
  if (isConnected && !ready) guidance = "Enable dictation in Agent Console’s Voice settings.";
  if (ready) guidance = "Speech is inserted into your brief as editable text.";
  if (voice.isRecording) guidance = "Listening. Select Insert when you’re finished.";

  return (
    <ScrollView style={styles.background} contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Dictate brief</Text>
      <Text accessibilityLiveRegion="polite" style={styles.description}>
        {guidance}
      </Text>
      {showControls ? (
        <DictationOverlay
          neutral
          labelActions
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
        <View style={styles.actions}>
          <Button variant="secondary" onPress={close}>
            Cancel
          </Button>
          <Button variant="secondary" disabled={!ready} onPress={startDictation}>
            Start recording
          </Button>
        </View>
      )}
      {voice.error && !showControls ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {voice.error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  background: { flex: 1, backgroundColor: theme.colors.surface0 },
  container: {
    flexGrow: 1,
    gap: 12,
    justifyContent: "center",
    padding: 22,
  },
  heading: { fontSize: 20, fontWeight: "600", color: theme.colors.foreground },
  description: { fontSize: 13, color: theme.colors.foregroundMuted },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  error: { fontSize: 13, color: theme.colors.destructive },
}));
