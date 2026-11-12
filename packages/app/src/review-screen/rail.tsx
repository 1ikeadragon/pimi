// Pimi. Apache-2.0.
// Stream S2 owns this file: the left rail. Title, search field, All / To review filter, and one row
// per change request (repo and number, title, state chips). Reads `forge.change_request.list_inbox`.
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ReviewRailProps } from "./types";

export function ReviewRail({ serverId, mode }: ReviewRailProps) {
  return (
    <View style={styles.slot} testID="review-rail">
      <Text style={styles.text}>
        {mode === "pull_requests" ? "Pull requests" : "Worktrees"} on {serverId}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: { flex: 1, padding: theme.spacing[4] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
