import { useTheme, type PluginComponentOverrideProps } from "@pimi/plugin/client";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useThrowFlag } from "./throw-flag";

/** Replaces the user's chat messages with a right-aligned bubble. */
export function UserBubble({ message, pending }: PluginComponentOverrideProps<"chat.userMessage">) {
  const theme = useTheme();
  const throws = useThrowFlag();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        bubble: {
          ...base.bubble,
          backgroundColor: theme.colors.accent,
          opacity: pending ? 0.6 : 1,
        },
        text: { color: theme.colors.accentForeground },
      }),
    [theme, pending],
  );
  if (throws) throw new Error("ui-overrides: the throw setting is on");
  return (
    <View style={base.row} testID="ui-overrides-user-bubble">
      <View style={styles.bubble}>
        <Text style={styles.text}>{message}</Text>
      </View>
    </View>
  );
}

const base = StyleSheet.create({
  row: { alignItems: "flex-end", paddingVertical: 6, paddingHorizontal: 12 },
  bubble: { maxWidth: "85%", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 },
});
