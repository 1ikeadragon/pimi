// Pimi. Apache-2.0.
// Stream S4 owns this directory: Threads / Checks / About tabs.
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ReviewInspectorProps } from "../types";

export function ReviewInspector({ tab }: ReviewInspectorProps) {
  return (
    <View style={styles.slot} testID="review-inspector">
      <Text style={styles.text}>Inspector: {tab}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: { flex: 1, minWidth: 0, padding: theme.spacing[6] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
