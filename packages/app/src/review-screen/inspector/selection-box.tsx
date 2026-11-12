// Pimi. Apache-2.0.
import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const accentForeground = (theme: Theme) => ({ color: theme.colors.accentForeground });

/** The batch "Fix N selected" tick on a thread or failing check row. */
export function SelectionBox({
  checked,
  onToggle,
  label,
  testID,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  testID?: string;
}) {
  const state = useMemo(() => ({ checked }), [checked]);
  const boxStyle = useMemo(() => [styles.box, checked && styles.boxChecked], [checked]);
  return (
    <PressHighlight
      onPress={onToggle}
      hitSlop={8}
      accessibilityRole="checkbox"
      accessibilityState={state}
      accessibilityLabel={label}
      testID={testID}
    >
      <View style={boxStyle}>
        {checked ? <ThemedCheck size={12} uniProps={accentForeground} /> : null}
      </View>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  box: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    alignItems: "center",
    justifyContent: "center",
  },
  boxChecked: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
}));

export function toggleInSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}
