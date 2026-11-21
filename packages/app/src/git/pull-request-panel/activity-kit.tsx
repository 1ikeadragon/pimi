// Pimi. PolyForm-Noncommercial-1.0.0.
// The author line of a pull-request activity: avatar, name, verb ("commented", "approved"), age.
// Shared by the chat pane's timeline and the Review screen's Conversation tab.
import { useMemo } from "react";
import { Text, View } from "react-native";
import { CircleCheck, CircleX } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { getActivityVerbKey } from "./data";
import type { PrPaneActivity } from "./data";
import { dangerColorMapping, successColorMapping } from "./section-kit";

const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleX = withUnistyles(CircleX);

export function ActivityAvatar({ activity, size }: { activity: PrPaneActivity; size: number }) {
  const frameStyle = useMemo(
    () => [
      styles.avatar,
      {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: activity.avatarColor,
      },
    ],
    [activity.avatarColor, size],
  );
  return (
    <View style={frameStyle}>
      <Text style={styles.avatarText}>{activity.author.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

export function ActivityVerb({ activity }: { activity: PrPaneActivity }) {
  const { t } = useTranslation();
  const verb = t(getActivityVerbKey(activity)).toLowerCase();
  if (activity.kind === "review" && activity.reviewState === "approved") {
    return (
      <View style={styles.verbGroup}>
        <ThemedCircleCheck size={12} uniProps={successColorMapping} />
        <Text style={styles.verbSuccess}>{verb}</Text>
      </View>
    );
  }
  if (activity.kind === "review" && activity.reviewState === "changes_requested") {
    return (
      <View style={styles.verbGroup}>
        <ThemedCircleX size={12} uniProps={dangerColorMapping} />
        <Text style={styles.verbDanger}>{verb}</Text>
      </View>
    );
  }
  return <Text style={styles.verbMuted}>{verb}</Text>;
}

export function ActivityHeader({
  activity,
  avatarSize,
  children,
}: {
  activity: PrPaneActivity;
  avatarSize: number;
  children?: React.ReactNode;
}) {
  return (
    <>
      <ActivityAvatar activity={activity} size={avatarSize} />
      <Text style={styles.authorText} numberOfLines={1}>
        {activity.author}
      </Text>
      <ActivityVerb activity={activity} />
      <View style={styles.headerTrailing}>
        <Text style={styles.ageText}>{activity.age}</Text>
        {children}
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  avatar: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.normal,
    color: "#fff",
  },
  headerTrailing: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  authorText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  verbGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  verbMuted: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  verbSuccess: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusSuccess,
  },
  verbDanger: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  ageText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
