import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Finding } from "@pimi/protocol/attack/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The owner's duplicate call: pick the finding this one repeats. The daemon folds this finding's
 * count, severity and evidence into the pick and hides this one.
 */
export function FindingMergeMenu({
  finding,
  candidates,
  disabled,
  onMerge,
}: {
  finding: Finding;
  candidates: readonly Finding[];
  disabled: boolean;
  onMerge: (target: Finding) => void;
}) {
  const { t } = useTranslation();
  const others = candidates.filter((candidate) => candidate.id !== finding.id);
  if (others.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        accessibilityLabel={t("attack.findings.merge.action")}
        testID="attack-finding-merge"
      >
        <View style={styles.trigger}>
          <Text style={styles.triggerText}>{t("attack.findings.merge.action")}</Text>
          <ChevronDown size={12} color="gray" />
        </View>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" scrollable maxHeight={320} minWidth={220} maxWidth={360}>
        <DropdownMenuLabel>{t("attack.findings.merge.pick")}</DropdownMenuLabel>
        {others.map((candidate) => (
          <MergeTarget key={candidate.id} candidate={candidate} onMerge={onMerge} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MergeTarget({
  candidate,
  onMerge,
}: {
  candidate: Finding;
  onMerge: (target: Finding) => void;
}) {
  const onSelect = useCallback(() => onMerge(candidate), [candidate, onMerge]);
  return (
    <DropdownMenuItem
      description={candidate.route}
      onSelect={onSelect}
      testID={`attack-merge-target-${candidate.id}`}
    >
      {candidate.title}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  triggerText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
