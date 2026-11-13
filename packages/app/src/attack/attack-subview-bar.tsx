import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import type { AttackRun } from "@pimi/protocol/attack/types";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { ATTACK_SUBVIEWS, type AttackSubview } from "./attack-store";

/** The strip under the run bar. Desktop is disabled while the run has no desktop target. */
export function AttackSubviewBar({
  run,
  value,
  onChange,
  agentCount,
  workingCount,
}: {
  run: AttackRun;
  value: AttackSubview;
  onChange: (view: AttackSubview) => void;
  agentCount: number;
  workingCount: number;
}) {
  const { t } = useTranslation();
  const hasDesktopTarget = run.desktopTarget !== null;
  const options = useMemo<SegmentedControlOption<AttackSubview>[]>(
    () =>
      ATTACK_SUBVIEWS.map((view) => ({
        value: view,
        label: t(`attack.subviews.${view}.label`),
        disabled: view === "desktop" && !hasDesktopTarget,
        testID: `attack-subview-tab-${view}`,
      })),
    [hasDesktopTarget, t],
  );
  return (
    <View style={styles.bar} testID="attack-subview-bar">
      <SegmentedControl
        options={options}
        value={value}
        onValueChange={onChange}
        size="sm"
        accessibilityLabel={t("attack.subviews.label")}
      />
      {value === "desktop" || hasDesktopTarget ? null : (
        <Text style={styles.hint} numberOfLines={1}>
          {t("attack.subviews.desktop.disabledHint")}
        </Text>
      )}
      <Text style={styles.count} numberOfLines={1} testID="attack-subview-count">
        {t("attack.subviews.agentCount", { count: agentCount, working: workingCount })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: theme.spacing[3],
    rowGap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  count: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
