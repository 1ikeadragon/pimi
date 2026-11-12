// Pimi. Apache-2.0.
// Stream S2 owns this file: change request title, branch line, and the unresolved/viewed/checks counters.
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ReviewHeaderProps } from "./types";

export function ReviewHeader({ source }: ReviewHeaderProps) {
  const label =
    source.kind === "change_request"
      ? `${source.owner}/${source.name} #${source.number}`
      : source.cwd;
  return (
    <View style={styles.slot} testID="review-header">
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));
