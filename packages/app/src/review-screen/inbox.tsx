// Pimi. Apache-2.0.
// Stream S2 owns this file: pull request inbox (To review / Mine / All, search, paste URL).
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ReviewInboxProps } from "./types";

export function ReviewInbox({ serverId }: ReviewInboxProps) {
  return (
    <View style={styles.slot} testID="review-inbox">
      <Text style={styles.text}>Pull requests inbox for {serverId}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: { flex: 1, padding: theme.spacing[6] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
