import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@pimi/protocol/agent-types";
import type { InstructionsTarget } from "@pimi/protocol/messages";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SettingsGroup } from "@/components/settings/headings/settings-group";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useTranslation } from "@/i18n/use-translation";
import { InstructionsList } from "./instructions-list";
import { useInstructions } from "./use-instructions";

interface ProjectInstructionsSectionProps {
  serverId: string;
  repoRoot: string;
}

/** What a new chat in this project would receive, for one provider at a time. */
export function ProjectInstructionsSection({
  serverId,
  repoRoot,
}: ProjectInstructionsSectionProps) {
  const { t } = useTranslation();
  const { entries } = useProvidersSnapshot(serverId, { cwd: repoRoot });
  const providers = useMemo(
    () => (entries ?? []).filter((entry) => entry.enabled && entry.status === "ready"),
    [entries],
  );
  const [chosen, setChosen] = useState<AgentProvider | null>(null);
  const provider = chosen ?? providers[0]?.provider ?? null;

  const options = useMemo<SegmentedControlOption<string>[]>(
    () =>
      providers.map((entry) => ({
        value: entry.provider,
        label: entry.label ?? entry.provider,
        testID: `project-instructions-provider-${entry.provider}`,
      })),
    [providers],
  );
  const target = useMemo<InstructionsTarget | null>(
    () => (provider === null ? null : { kind: "draft", provider, cwd: repoRoot, profileId: null }),
    [provider, repoRoot],
  );
  const query = useInstructions(serverId, target);
  const handleProviderChange = useCallback((value: string) => setChosen(value), []);

  return (
    <SettingsGroup
      title={t("settings.project.instructions.title")}
      info={t("settings.project.instructions.info")}
      testID="instructions-group"
    >
      <View style={styles.stack}>
        {provider === null ? null : (
          <SegmentedControl
            options={options}
            value={provider}
            onValueChange={handleProviderChange}
            accessibilityLabel={t("settings.project.instructions.provider")}
            testID="project-instructions-provider"
          />
        )}
        <InstructionsList query={query} testID="project-instructions-list" />
      </View>
    </SettingsGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.spacing[3],
  },
}));
