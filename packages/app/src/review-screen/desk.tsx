// Pimi. Apache-2.0.
// Stream S3 owns this file: file tree beside the diff, viewed marks, continuous/single-file modes.
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ReviewDeskProps } from "./types";

export function ReviewDesk({ focus }: ReviewDeskProps) {
  return (
    <View style={styles.slot} testID="review-desk">
      <Text style={styles.text}>
        Diff desk{focus ? ` (focus ${focus.path}:${focus.line ?? "-"})` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: { flex: 1, minWidth: 0, padding: theme.spacing[6] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
