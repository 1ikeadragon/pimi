import type { ProjectSuggestionsController } from "@/project-suggestions";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type { OnboardingStepId } from "../model";
import type { OrchestrationSetupController } from "../orchestration-setup";
import { AttackStep } from "./attack-step";
import { AppearanceStep } from "./appearance-step";
import { GitProvidersStep } from "./git-providers-step";
import { MachineStep } from "./machine-step";
import { OrchestrationStep } from "./orchestration-step";
import { PhoneStep } from "./phone-step";
import { ProjectsStep } from "./projects-step";
import { ProvidersStep } from "./providers-step";

export function OnboardingStepContent({
  step,
  serverId,
  projectSuggestions,
  orchestration,
  onAdvance,
}: {
  step: OnboardingStepId;
  serverId: string;
  projectSuggestions: ProjectSuggestionsController;
  orchestration: OrchestrationSetupController;
  onAdvance: () => void;
}) {
  switch (step) {
    case "appearance":
      return <AppearanceStep />;
    case "providers":
      return <ProvidersStep serverId={serverId} />;
    case "gitProviders":
      return <GitProvidersStep />;
    case "projects":
      return <ProjectsStep serverId={serverId} suggestions={projectSuggestions} />;
    case "orchestration":
      return <OrchestrationStep setup={orchestration} />;
    case "attack":
      return <AttackStep />;
    case "phone":
      return <PhoneStep serverId={serverId} />;
    case "machine":
      return <MachineStep onUseThisComputer={onAdvance} />;
    case "welcome":
      return null;
    case "firstChat":
      return <PimiAgentTools serverId={serverId} />;
  }
}

function PimiAgentTools({ serverId }: { serverId: string }) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const enabled = config?.mcp.injectIntoAgents === true;
  const enable = useCallback(async () => {
    setBusy(true);
    setError(false);
    try {
      setError(!(await patchConfig({ mcp: { injectIntoAgents: true } })));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, [patchConfig]);

  return (
    <View style={styles.tools}>
      <Text style={styles.label}>Agent tools</Text>
      <Text style={styles.detail}>
        {enabled
          ? "Agents can propose tasks and coordinate worktrees and sessions."
          : "Enable tools so agents can propose tasks and coordinate worktrees and sessions."}
      </Text>
      {enabled ? null : (
        <Button variant="secondary" onPress={enable} loading={busy} disabled={!config}>
          Enable agent tools
        </Button>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={styles.detail}>
          Agent tools couldn’t be enabled. Try again or check Settings.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: { color: theme.colors.foregroundMuted, fontWeight: theme.fontWeight.semibold },
  detail: { color: theme.colors.foregroundMuted },
  tools: { alignItems: "flex-start", gap: 6, paddingTop: 8 },
}));
