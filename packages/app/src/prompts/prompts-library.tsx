import { useCallback, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SavedPrompt } from "@pimi/protocol/prompt/types";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/use-translation";
import { getHostProjectId, useHostProjects } from "@/projects/host-projects";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { PromptEditorSheet, type PromptEditorTarget } from "./prompt-editor";
import { PromptSuggestionsSection, type SuggestionToSave } from "./prompt-suggestions-section";
import { usePromptMutations, usePrompts } from "./use-prompts";

const NEW_PROMPT_VALUES = { name: "", text: "", projectId: null } as const;

export function PromptsLibrary({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const prompts = usePrompts(serverId);
  const mutations = usePromptMutations(serverId);
  const serverIds = useMemo(() => [serverId], [serverId]);
  const projects = useHostProjects(serverIds);
  const [editor, setEditor] = useState<PromptEditorTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = prompts.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects) {
      const projectId = getHostProjectId(project, serverId);
      if (projectId) names.set(projectId, project.projectName);
    }
    return names;
  }, [projects, serverId]);
  const scopeLabel = useCallback(
    (projectId: string | null) =>
      projectId === null
        ? t("prompts.allProjects")
        : (projectNames.get(projectId) ?? t("prompts.unknownProject")),
    [projectNames, t],
  );

  const openNew = useCallback(
    () =>
      setEditor({
        editing: null,
        initial: NEW_PROMPT_VALUES,
        initialProjectLabel: scopeLabel(null),
      }),
    [scopeLabel],
  );
  const openEdit = useCallback(
    (prompt: SavedPrompt) =>
      setEditor({
        editing: prompt,
        initial: { name: prompt.name, text: prompt.text, projectId: prompt.projectId },
        initialProjectLabel: scopeLabel(prompt.projectId),
      }),
    [scopeLabel],
  );
  const openSuggestion = useCallback(
    (suggestion: SuggestionToSave) =>
      setEditor({
        editing: null,
        initial: { name: "", text: suggestion.text, projectId: suggestion.projectId },
        initialProjectLabel: suggestion.projectLabel,
      }),
    [],
  );
  const closeEditor = useCallback(() => setEditor(null), []);
  const handleDelete = useCallback(
    async (prompt: SavedPrompt) => {
      const confirmed = await confirmDialog({
        title: t("prompts.deleteTitle"),
        message: t("prompts.deleteMessage", { name: prompt.name }),
        confirmLabel: t("prompts.delete"),
        destructive: true,
      });
      if (!confirmed) return;
      setError(null);
      try {
        await mutations.deletePrompt(prompt.id);
      } catch (cause) {
        setError(toErrorMessage(cause));
      }
    },
    [mutations, t],
  );

  const newButton = useMemo(
    () => (
      <Button variant="outline" leftIcon={Plus} onPress={openNew} testID="prompts-new">
        {t("prompts.newPrompt")}
      </Button>
    ),
    [openNew, t],
  );

  if (!prompts.data) {
    return (
      <SettingsSection title={t("prompts.title")} testID="prompts-library">
        <SettingsCard>
          <SettingsRow label={prompts.isError ? t("prompts.loadFailed") : t("prompts.loading")}>
            {prompts.isError ? (
              <Button variant="outline" onPress={retry}>
                {t("prompts.retry")}
              </Button>
            ) : null}
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }
  return (
    <View testID="prompts-library">
      <SettingsSection title={t("prompts.title")} info={t("prompts.intro")} trailing={newButton}>
        <SettingsCard>
          {prompts.data.length === 0 ? <SettingsRow label={t("prompts.empty")} /> : null}
          {prompts.data.map((prompt) => (
            <PromptRow
              key={prompt.id}
              prompt={prompt}
              scope={scopeLabel(prompt.projectId)}
              onEdit={openEdit}
              onDelete={handleDelete}
            />
          ))}
        </SettingsCard>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </SettingsSection>
      <PromptSuggestionsSection serverId={serverId} onSave={openSuggestion} />
      <PromptEditorSheet serverId={serverId} target={editor} onClose={closeEditor} />
    </View>
  );
}

function PromptRow({
  prompt,
  scope,
  onEdit,
  onDelete,
}: {
  prompt: SavedPrompt;
  scope: string;
  onEdit: (prompt: SavedPrompt) => void;
  onDelete: (prompt: SavedPrompt) => void;
}) {
  const { t } = useTranslation();
  const edit = useCallback(() => onEdit(prompt), [onEdit, prompt]);
  const remove = useCallback(() => onDelete(prompt), [onDelete, prompt]);
  const hint = useMemo(
    () => (
      <View style={styles.hint}>
        <Text style={styles.meta} numberOfLines={2}>
          {prompt.text}
        </Text>
        <Text style={styles.meta}>
          /{prompt.name} · {scope}
        </Text>
      </View>
    ),
    [prompt.name, prompt.text, scope],
  );
  return (
    <SettingsRow
      label={prompt.name}
      onLabelPress={edit}
      hint={hint}
      testID={`prompt-row-${prompt.name}`}
    >
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          leftIcon={Pencil}
          onPress={edit}
          testID={`prompt-edit-${prompt.name}`}
        >
          {t("prompts.edit")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Trash2}
          onPress={remove}
          accessibilityLabel={t("prompts.delete")}
          testID={`prompt-delete-${prompt.name}`}
        />
      </View>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  hint: { gap: theme.spacing[0.5] },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
