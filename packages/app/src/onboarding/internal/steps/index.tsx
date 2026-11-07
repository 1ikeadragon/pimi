import type { ProjectSuggestionsController } from "@/project-suggestions";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type { OnboardingStepId } from "../model";
import type { OrchestrationSetupController } from "../orchestration-setup";
import { AppearanceStep } from "./appearance-step";
import { OrchestrationStep } from "./orchestration-step";
import { PhoneStep } from "./phone-step";
import { ProjectsStep } from "./projects-step";
import { ProvidersStep } from "./providers-step";

export function OnboardingStepContent({
  step,
  serverId,
  projectSuggestions,
  orchestration,
}: {
  step: OnboardingStepId;
  serverId: string;
  projectSuggestions: ProjectSuggestionsController;
  orchestration: OrchestrationSetupController;
}) {
  switch (step) {
    case "appearance":
      return <AppearanceStep />;
    case "providers":
      return <ProvidersStep serverId={serverId} />;
    case "projects":
      return <ProjectsStep serverId={serverId} suggestions={projectSuggestions} />;
    case "orchestration":
      return <OrchestrationStep setup={orchestration} />;
    case "phone":
      return <PhoneStep serverId={serverId} />;
    case "welcome":
      return <PimiExamples />;
    case "firstChat":
      return (
        <View style={styles.examples}>
          <PimiExamples />
          <PimiAgentTools serverId={serverId} />
        </View>
      );
  }
}

function PimiExamples() {
  return (
    <View style={styles.examples}>
      <View style={styles.example}>
        <Text style={styles.label}>Ask in chat</Text>
        <Text style={styles.exampleText}>“Walk me through how requests reach this handler.”</Text>
        <Text style={styles.detail}>Get an answer or work through a focused change together.</Text>
      </View>
      <View style={styles.example}>
        <Text style={styles.label}>Keep track in Tasks</Text>
        <Text style={styles.exampleText}>
          “Try two ways to speed up this handler and compare them.”
        </Text>
        <Text style={styles.detail}>
          Review the suggested brief and experiments before saving them.
        </Text>
      </View>
    </View>
  );
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
  examples: { gap: 10 },
  example: { gap: 5, padding: 14, borderRadius: 12, backgroundColor: theme.colors.surface1 },
  label: { color: theme.colors.foregroundMuted, fontWeight: theme.fontWeight.semibold },
  exampleText: { color: theme.colors.foreground, fontSize: theme.fontSize.lg },
  detail: { color: theme.colors.foregroundMuted },
  tools: { alignItems: "flex-start", gap: 6, paddingTop: 8 },
}));
