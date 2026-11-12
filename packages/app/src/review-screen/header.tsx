// Pimi. Apache-2.0.
// Stream S2 owns this file: the top bar (back/forward, Pull requests / Worktrees) and the detail
// header (repo and number, title, state/branch/counter chips, Overview / Changes tabs).
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ReviewDetailHeaderProps, ReviewHeaderProps } from "./types";

export function ReviewHeader({ mode }: ReviewHeaderProps) {
  return (
    <View style={styles.bar} testID="review-header">
      <Text style={styles.text}>{mode === "pull_requests" ? "Pull requests" : "Worktrees"}</Text>
    </View>
  );
}

export function ReviewDetailHeader({ source, tab }: ReviewDetailHeaderProps) {
  const label =
    source.kind === "change_request"
      ? `${source.owner}/${source.name} #${source.number}`
      : source.cwd;
  return (
    <View style={styles.bar} testID="review-detail-header">
      <Text style={styles.text}>
        {label} ({tab})
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));
