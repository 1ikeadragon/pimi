import { MarkdownRenderer } from "@/components/markdown/renderer";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { cardStyles } from "@/styles/card";
import { ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

export type PlanOutcome = "pending" | "approved" | "rejected" | "canceled";

interface PlanCardProps {
  title?: string;
  description?: string;
  text: string;
  outcome?: PlanOutcome;
  footer?: ReactNode;
  disableOuterSpacing?: boolean;
  testID?: string;
}

const ThemedChevron = withUnistyles(ChevronRight);
const chevronColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function PlanCard(props: PlanCardProps) {
  // A resolution starts its own presentation state; subsequent taps stay local.
  return <PlanCardContent key={props.outcome ?? "proposed"} {...props} />;
}

function PlanCardContent({
  title,
  description,
  text,
  outcome,
  footer,
  disableOuterSpacing = false,
  testID,
}: PlanCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(outcome !== "rejected" && outcome !== "canceled");
  const labels = {
    pending: title ?? t("agentStream.permission.plan"),
    rejected: t("agentStream.permission.rejectedPlan"),
    approved: t("agentStream.permission.approvedPlan"),
    canceled: t("agentStream.permission.canceledPlan"),
  };
  const resolvedTitle = labels[outcome ?? "pending"];
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const webExpandedState = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  const [hovered, setHovered] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const headerStyle = useMemo(() => [styles.header, hovered && styles.headerHighlight], [hovered]);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const containerStyle = useMemo(
    () => [cardStyles.surface, !disableOuterSpacing && styles.spacing],
    [disableOuterSpacing],
  );
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );

  return (
    <View testID={testID} style={containerStyle}>
      <PressHighlight
        {...webExpandedState}
        accessibilityRole="button"
        accessibilityLabel={resolvedTitle}
        accessibilityState={accessibilityState}
        onPress={toggleExpanded}
        onHoverIn={hoverIn}
        onHoverOut={hoverOut}
        highlightStyle={styles.headerHighlight}
        style={headerStyle}
      >
        <Text style={cardStyles.title}>{resolvedTitle}</Text>
        <View style={chevronStyle}>
          <ThemedChevron size={ICON_SIZE.sm} uniProps={chevronColor} />
        </View>
      </PressHighlight>
      {expanded ? (
        <View style={styles.body}>
          {description ? <Text style={cardStyles.text}>{description}</Text> : null}
          <View style={styles.markdown}>
            <MarkdownRenderer text={text} />
          </View>
        </View>
      ) : null}
      {footer}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  spacing: {
    marginVertical: theme.spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    minHeight: 28,
    borderRadius: theme.borderRadius.md,
  },
  headerHighlight: { backgroundColor: theme.colors.interactionHighlight },
  chevron: {},
  chevronExpanded: { transform: [{ rotate: "90deg" }] },
  body: { gap: theme.spacing[1] },
  markdown: { paddingHorizontal: theme.spacing[1] },
}));
