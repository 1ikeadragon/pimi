// Pimi. Apache-2.0.
// Stream S4 owns this file: the Overview tab. Stacked cards built with SettingsSection: Description,
// a separate Checks card (failed first, passed/skipped collapsed), Threads, Commits. The same
// Threads and Checks components feed the Changes tab's inspector.
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ReviewOverviewProps } from "./types";

export function ReviewOverview(_props: ReviewOverviewProps) {
  return (
    <View style={styles.slot} testID="review-overview">
      <Text style={styles.text}>Overview cards</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: { flex: 1, minWidth: 0, padding: theme.spacing[4] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
