import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TooltipRow } from "./runtime";

/** A mark's values, shown inside the popover every chat visual uses. */
export function VegaTooltipRows({ rows }: { rows: readonly TooltipRow[] }) {
  return (
    <View style={styles.rows}>
      {rows.map(({ label, value }) => (
        <View key={label} style={styles.row}>
          {label ? <Text style={styles.label}>{label}</Text> : null}
          <Text style={styles.value}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rows: { gap: theme.spacing[1] },
  row: { flexDirection: "row", gap: theme.spacing[3], justifyContent: "space-between" },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    maxWidth: 220,
  },
}));
