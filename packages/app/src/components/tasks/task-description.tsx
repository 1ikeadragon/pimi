import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useTranslation } from "@/i18n/use-translation";
import type { AggregatedTask } from "@/tasks/aggregated-tasks";

/** The description line, or the spinner line while the daemon writes it. Nothing otherwise. */
export function TaskDescription({
  task,
  lines,
}: {
  task: Pick<AggregatedTask, "description" | "descriptionPending">;
  lines: number;
}): ReactElement | null {
  const { t } = useTranslation();
  if (task.description) {
    return (
      <Text style={styles.text} numberOfLines={lines} pointerEvents="none">
        {task.description}
      </Text>
    );
  }
  if (!task.descriptionPending) return null;
  return (
    <View style={styles.pending} pointerEvents="none">
      <LoadingSpinner size="small" color={styles.spinner.color} />
      <Text style={styles.text} numberOfLines={1}>
        {t("tasks.row.describing")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  pending: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  spinner: { color: theme.colors.foregroundMuted },
}));
