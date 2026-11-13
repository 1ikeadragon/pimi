import { useTheme, type PluginComponentOverrideProps } from "@pimi/plugin/client";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

/** Replaces the About page of Settings; every other page renders unchanged through `Original`. */
export function AboutOverride({
  slug,
  Original,
}: PluginComponentOverrideProps<"settings.section">) {
  const theme = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" },
        body: { color: theme.colors.foregroundMuted },
      }),
    [theme],
  );
  if (slug !== "about") return <Original />;
  return (
    <View style={base.page} testID="ui-overrides-about">
      <Text style={styles.title}>About, as a plugin sees it</Text>
      <Text style={styles.body}>
        The ui-overrides example replaced this page. Disable the plugin to get the original back.
      </Text>
    </View>
  );
}

const base = StyleSheet.create({ page: { padding: 16, gap: 8 } });
