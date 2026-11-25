import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PromptSuggestion } from "@pimi/protocol/prompt/types";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/use-translation";
import { getHostProjectId, useHostProjects } from "@/projects/host-projects";
import { toErrorMessage } from "@/utils/error-messages";
import { useDismissPromptSuggestion, usePromptSuggestions } from "./use-prompt-suggestions";

export interface SuggestionToSave {
  text: string;
  projectId: string;
  projectLabel: string;
}

interface PromptSuggestionsSectionProps {
  serverId: string;
  /** Opens the prompt editor on the phrase; the name is the person's to choose. */
  onSave: (suggestion: SuggestionToSave) => void;
}

interface ProjectChoice {
  projectId: string;
  label: string;
}

export function PromptSuggestionsSection({ serverId, onSave }: PromptSuggestionsSectionProps) {
  const { t } = useTranslation();
  const serverIds = useMemo(() => [serverId], [serverId]);
  const projects = useHostProjects(serverIds);
  const choices = useMemo(() => {
    const found: ProjectChoice[] = [];
    for (const project of projects) {
      const projectId = getHostProjectId(project, serverId);
      if (projectId) found.push({ projectId, label: project.projectName });
    }
    return found;
  }, [projects, serverId]);
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  const selected =
    choices.find((choice) => choice.projectId === pickedProjectId) ?? choices[0] ?? null;
  const options = useMemo(
    () => choices.map((choice) => ({ value: choice.projectId, label: choice.label })),
    [choices],
  );
  const suggestions = usePromptSuggestions({
    serverId,
    projectId: selected?.projectId ?? null,
    position: "any",
  });
  const dismiss = useDismissPromptSuggestion(serverId);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const refetch = suggestions.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);

  const handleSave = useCallback(
    (suggestion: PromptSuggestion) => {
      if (!selected) return;
      onSave({
        text: suggestion.text,
        projectId: selected.projectId,
        projectLabel: selected.label,
      });
    },
    [onSave, selected],
  );
  const handleDismiss = useCallback(
    async (suggestion: PromptSuggestion) => {
      if (!selected) return;
      setDismissError(null);
      try {
        await dismiss({ projectId: selected.projectId, key: suggestion.key });
      } catch (cause) {
        setDismissError(toErrorMessage(cause));
      }
    },
    [dismiss, selected],
  );

  if (!selected) return null;
  return (
    <SettingsSection title={t("prompts.suggestions.title")} info={t("prompts.suggestions.intro")}>
      <SettingsCard>
        <SettingsSelect
          label={t("prompts.suggestions.project")}
          value={selected.projectId}
          options={options}
          onValueChange={setPickedProjectId}
          disabled={options.length < 2}
        />
        <SuggestionRows
          suggestions={suggestions}
          onRetry={retry}
          onSave={handleSave}
          onDismiss={handleDismiss}
        />
      </SettingsCard>
      {dismissError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {dismissError}
        </Text>
      ) : null}
    </SettingsSection>
  );
}

function SuggestionRows({
  suggestions,
  onRetry,
  onSave,
  onDismiss,
}: {
  suggestions: ReturnType<typeof usePromptSuggestions>;
  onRetry: () => void;
  onSave: (suggestion: PromptSuggestion) => void;
  onDismiss: (suggestion: PromptSuggestion) => void;
}) {
  const { t } = useTranslation();
  if (suggestions.isError) {
    return (
      <SettingsRow
        label={t("prompts.suggestions.loadFailed")}
        hint={toErrorMessage(suggestions.error)}
      >
        <Button variant="outline" onPress={onRetry}>
          {t("common.actions.retry")}
        </Button>
      </SettingsRow>
    );
  }
  if (!suggestions.data) return <SettingsRow label={t("prompts.suggestions.loading")} />;
  if (suggestions.data.length === 0) return <SettingsRow label={t("prompts.suggestions.empty")} />;
  return (
    <>
      {suggestions.data.map((suggestion) => (
        <SuggestionRow
          key={suggestion.key}
          suggestion={suggestion}
          onSave={onSave}
          onDismiss={onDismiss}
        />
      ))}
    </>
  );
}

function SuggestionRow({
  suggestion,
  onSave,
  onDismiss,
}: {
  suggestion: PromptSuggestion;
  onSave: (suggestion: PromptSuggestion) => void;
  onDismiss: (suggestion: PromptSuggestion) => void;
}) {
  const { t } = useTranslation();
  const save = useCallback(() => onSave(suggestion), [onSave, suggestion]);
  const dismiss = useCallback(() => onDismiss(suggestion), [onDismiss, suggestion]);
  const hint = useMemo(
    () => (
      <Text style={styles.meta}>
        {t("prompts.suggestions.usedIn", { count: suggestion.chats })}
      </Text>
    ),
    [suggestion.chats, t],
  );
  return (
    <SettingsRow label={suggestion.text} hint={hint} testID="prompt-suggestion-row">
      <View style={styles.actions}>
        <Button size="sm" variant="outline" onPress={save} testID="prompt-suggestion-save">
          {t("prompts.suggestions.save")}
        </Button>
        <Button size="sm" variant="ghost" onPress={dismiss} testID="prompt-suggestion-dismiss">
          {t("prompts.suggestions.dismiss")}
        </Button>
      </View>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
