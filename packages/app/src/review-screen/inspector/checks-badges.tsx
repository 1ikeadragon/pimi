// Pimi. Apache-2.0.
import { useTranslation } from "@/i18n/use-translation";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ReviewCheckSection } from "../use-review-timeline";

const BADGES: Record<
  ReviewCheckSection["id"],
  { key: string; variant: "error" | "warning" | "success" | "muted" }
> = {
  attention: { key: "reviewScreen.inspector.badgeFailed", variant: "error" },
  running: { key: "reviewScreen.inspector.badgeRunning", variant: "warning" },
  passed: { key: "reviewScreen.inspector.badgePassed", variant: "success" },
  skipped: { key: "reviewScreen.inspector.badgeSkipped", variant: "muted" },
};

/** "1 failed · 25 passed · 6 skipped" as pills, for a card header. */
export function ChecksBadges({ sections }: { sections: readonly ReviewCheckSection[] }) {
  const { t } = useTranslation();
  return (
    <View style={styles.row}>
      {sections.map((section) => (
        <StatusBadge
          key={section.id}
          size="xs"
          variant={BADGES[section.id].variant}
          label={t(BADGES[section.id].key, { count: section.count })}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
}));
