import { type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AgentProfileGlyph, useAgentProfiles } from "@/agent-profiles";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";
import type { DraftAttachedProfile } from "./input-draft";

const ThemedX = withUnistyles(X);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The profile a draft will start its agent with, or that a running agent was started with. Its
 * instructions are not visible anywhere else in the composer, so the chip is the only sign of
 * them. On a draft it can be removed, which sends none.
 */
export function ProfileChip({
  serverId,
  profile,
  onDetach,
  disabled,
}: {
  serverId: string | null;
  profile: DraftAttachedProfile;
  onDetach: (() => void) | undefined;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { profiles } = useAgentProfiles(serverId);
  const stored = profiles?.find((entry) => entry.id === profile.id);
  const name = stored?.name ?? profile.name;

  return (
    <View
      style={styles.chip}
      testID="profile-chip"
      accessibilityLabel={t("profiles.attachedLabel", { name })}
    >
      <AgentProfileGlyph icon={stored?.icon} color={stored?.color} size={12} />
      <Text style={styles.label} numberOfLines={1}>
        {name}
      </Text>
      {onDetach ? (
        <PressHighlight
          onPress={onDetach}
          disabled={disabled}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t("profiles.detach")}
          testID="profile-chip-detach"
          style={styles.detach}
          highlightStyle={styles.detachPressed}
        >
          <ThemedX size={12} uniProps={mutedColorMapping} />
        </PressHighlight>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    flexShrink: 1,
    height: 24,
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  label: {
    flexShrink: 1,
    maxWidth: 160,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  detach: {
    padding: 2,
    borderRadius: theme.borderRadius.full,
  },
  detachPressed: {
    backgroundColor: theme.colors.surface2,
  },
}));
