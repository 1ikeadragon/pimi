import { memo, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PimiMascot } from "@/components/icons/pimi-mascot";
import type { ToolCallRun } from "../grouping";
import { summarizeToolCalls } from "./model";
import { useOverviewSummaryLabel } from "./label";
import { OverviewToolCallDetails } from "./view";
import { OverviewToolCallGroupSheet } from "./sheet";

interface LiveToolCallStepsProps {
  run: ToolCallRun;
  expanded: boolean;
  isCompact: boolean;
  onClose: () => void;
  /** The per-call rows; only passed while open. */
  children: ReactNode;
}

const SHEET_ICON = <PimiMascot size={20} />;

/**
 * The steps of the run the working status line owns. Compact opens the group sheet; wider
 * layouts open the same rows inline, above the line.
 */
export const LiveToolCallSteps = memo(function LiveToolCallSteps({
  run,
  expanded,
  isCompact,
  onClose,
  children,
}: LiveToolCallStepsProps) {
  const summary = useMemo(() => summarizeToolCalls(run.calls), [run.calls]);
  const sentence = useOverviewSummaryLabel(summary);

  if (isCompact) {
    return (
      <OverviewToolCallGroupSheet
        visible={expanded}
        summary={sentence}
        icon={SHEET_ICON}
        onClose={onClose}
      >
        {children}
      </OverviewToolCallGroupSheet>
    );
  }
  if (!expanded) return null;
  return (
    <View style={styles.panel} testID="live-tool-call-steps">
      {run.calls.length > 1 ? (
        <Text style={styles.sentence} numberOfLines={1}>
          {sentence}
        </Text>
      ) : null}
      <OverviewToolCallDetails>{children}</OverviewToolCallDetails>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  panel: {
    alignSelf: "stretch",
    paddingBottom: theme.spacing[1],
  },
  sentence: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: 13,
    paddingBottom: theme.spacing[1],
  },
}));
