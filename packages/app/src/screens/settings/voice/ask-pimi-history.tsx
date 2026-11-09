import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { usePimiVoiceHistory } from "@/desktop/pimi-voice-history";
import { settingsStyles } from "@/styles/settings";

export function AskPimiHistory() {
  const entries = usePimiVoiceHistory((state) => state.entries);
  const clear = usePimiVoiceHistory((state) => state.clear);
  const hasHistory = entries.length > 0;
  const clearButton = useMemo(
    () =>
      hasHistory ? (
        <Button size="sm" variant="ghost" onPress={clear} testID="ask-pimi-history-clear">
          Clear history
        </Button>
      ) : undefined,
    [clear, hasHistory],
  );

  return (
    <SettingsSection
      title="Ask Pimi history"
      info="The last 20 commands are saved on this device as text. Audio is never saved here."
      trailing={clearButton}
      testID="ask-pimi-history"
    >
      <SettingsCard>
        {hasHistory ? (
          entries.map((entry, index) => (
            <View key={entry.id} style={[styles.row, index > 0 && settingsStyles.rowBorder]}>
              <Text style={styles.time}>{new Date(entry.at).toLocaleString()}</Text>
              <Text selectable style={styles.transcript}>
                {entry.transcript}
              </Text>
              <Text selectable style={entry.outcome?.failed ? styles.error : styles.time}>
                {entry.outcome?.message || "Transcript received"}
              </Text>
            </View>
          ))
        ) : (
          <Text style={[styles.row, styles.time]}>No voice commands yet.</Text>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { padding: theme.spacing[3], gap: theme.spacing[1] },
  time: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  transcript: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
