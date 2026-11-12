// Pimi. Apache-2.0.
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ReviewCheckSection } from "../use-review-timeline";

const BADGES: Record<
  ReviewCheckSection["id"],
  { label: string; variant: "error" | "warning" | "success" | "muted" }
> = {
  attention: { label: "failed", variant: "error" },
  running: { label: "running", variant: "warning" },
  passed: { label: "passed", variant: "success" },
  skipped: { label: "skipped", variant: "muted" },
};

/** "1 failed · 25 passed · 6 skipped" as pills, for a card header. */
export function ChecksBadges({ sections }: { sections: readonly ReviewCheckSection[] }) {
  return (
    <View style={styles.row}>
      {sections.map((section) => (
        <StatusBadge
          key={section.id}
          size="xs"
          variant={BADGES[section.id].variant}
          label={`${section.count} ${BADGES[section.id].label}`}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
}));
