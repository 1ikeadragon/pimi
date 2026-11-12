// Pimi. Apache-2.0.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { requestReviewFix } from "../agent-actions/fix-request";
import { EMPTY_REVIEW_SELECTION, type ReviewSelection } from "../types";

/** "Fix N selected" for the ticked threads and checks; appears only while something is ticked. */
export function FixSelectedBar({
  selection,
  onSelectionChange,
}: {
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
}) {
  const { t } = useTranslation();
  const count = selection.threads.size + selection.checks.size;
  const clear = useCallback(() => onSelectionChange(EMPTY_REVIEW_SELECTION), [onSelectionChange]);
  const fix = useCallback(
    () => requestReviewFix({ threadIds: [...selection.threads], checkKeys: [...selection.checks] }),
    [selection],
  );
  if (count === 0) return null;
  return (
    <View style={styles.bar} testID="review-fix-selected">
      <Text style={styles.text}>{t("reviewScreen.inspector.selectedCount", { count })}</Text>
      <View style={styles.actions}>
        <Button size="sm" variant="ghost" onPress={clear}>
          {t("reviewScreen.inspector.clear")}
        </Button>
        <Button size="sm" variant="default" onPress={fix} testID="review-fix-selected-button">
          {t("reviewScreen.inspector.fixSelected", { count })}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
}));
