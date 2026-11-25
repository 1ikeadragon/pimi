import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MAX_FLOW_NAME_LENGTH } from "@pimi/protocol/flow/types";
import { MAX_SAVED_PROMPT_TEXT_LENGTH, type SavedPrompt } from "@pimi/protocol/prompt/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { reservedClientSlashCommandNames } from "@/client-slash-commands";
import { useTranslation } from "@/i18n/use-translation";
import { getHostProjectId, useHostProjects } from "@/projects/host-projects";
import { toErrorMessage } from "@/utils/error-messages";
import {
  openPromptForm,
  type PromptFieldError,
  type PromptFormValues,
} from "./prompt-editor-model";
import { usePromptMutations } from "./use-prompts";

/** What the editor opens on: a saved prompt to edit, or a new one, possibly prefilled. */
export interface PromptEditorTarget {
  editing: SavedPrompt | null;
  initial: PromptFormValues;
  initialProjectLabel: string;
}

interface PromptEditorSheetProps {
  serverId: string;
  /** Null closes the sheet; every open mounts a fresh form. */
  target: PromptEditorTarget | null;
  onClose: () => void;
}

const FIELD_ERROR_KEYS: Record<PromptFieldError, string> = {
  name_required: "prompts.editor.errors.nameRequired",
  bad_name: "prompts.editor.errors.badName",
  reserved: "prompts.editor.errors.reserved",
  text_required: "prompts.editor.errors.textRequired",
  text_too_long: "prompts.editor.errors.textTooLong",
};

const FIELD_ERROR_LIMITS = {
  nameMax: MAX_FLOW_NAME_LENGTH,
  textMax: MAX_SAVED_PROMPT_TEXT_LENGTH,
} as const;

export function PromptEditorSheet({ serverId, target, onClose }: PromptEditorSheetProps) {
  if (!target) return null;
  return <PromptEditorForm serverId={serverId} target={target} onClose={onClose} />;
}

function PromptEditorForm({
  serverId,
  target,
  onClose,
}: {
  serverId: string;
  target: PromptEditorTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const mutations = usePromptMutations(serverId);
  const serverIds = useMemo(() => [serverId], [serverId]);
  const projects = useHostProjects(serverIds);
  const [model] = useState(() =>
    openPromptForm({
      editing: target.editing,
      initial: target.initial,
      initialProjectLabel: target.initialProjectLabel,
      reservedNames: reservedClientSlashCommandNames(),
    }),
  );
  useEffect(
    () => () => {
      model.close();
    },
    [model],
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);

  const projectOptions = useMemo<SelectFieldOption<string | null>[]>(() => {
    const all: SelectFieldOption<string | null> = {
      id: "all",
      value: null,
      label: t("prompts.allProjects"),
    };
    const scoped = projects.flatMap((project) => {
      const projectId = getHostProjectId(project, serverId);
      if (!projectId) return [];
      return [{ id: projectId, value: projectId, label: project.projectName }];
    });
    return [all, ...scoped];
  }, [projects, serverId, t]);
  const selectedDisplay = useMemo(() => ({ label: state.projectLabel }), [state.projectLabel]);
  const handleProject = useCallback(
    (projectId: string | null, display: { label: string }) =>
      model.setProject(projectId, display.label),
    [model],
  );
  const getProjectKey = useCallback((value: string | null) => value ?? "all", []);

  const { editing } = target;
  const save = useCallback(async () => {
    const definition = model.beginSubmit();
    if (!definition) return;
    try {
      if (editing) {
        await mutations.updatePrompt({ promptId: editing.id, definition });
      } else {
        await mutations.createPrompt(definition);
      }
      onClose();
    } catch (error) {
      model.endSubmit(toErrorMessage(error));
    }
  }, [editing, model, mutations, onClose]);
  const handleSave = useCallback(() => void save(), [save]);

  const header = useMemo<SheetHeader>(
    () => ({ title: editing ? t("prompts.editor.editTitle") : t("prompts.editor.newTitle") }),
    [editing, t],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" onPress={onClose} disabled={state.isSubmitting}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={handleSave}
          loading={state.isSubmitting}
          disabled={state.isSubmitting}
          testID="prompt-editor-save"
        >
          {state.isSubmitting ? t("prompts.editor.saving") : t("common.actions.save")}
        </Button>
      </View>
    ),
    [handleSave, onClose, state.isSubmitting, t],
  );
  const nameError = state.nameError
    ? t(FIELD_ERROR_KEYS[state.nameError], FIELD_ERROR_LIMITS)
    : null;
  const textError = state.textError
    ? t(FIELD_ERROR_KEYS[state.textError], FIELD_ERROR_LIMITS)
    : null;

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      testID="prompt-editor"
    >
      <Field label={t("prompts.editor.name")} error={nameError} testID="prompt-editor-name-field">
        <FormTextInput
          testID="prompt-editor-name"
          accessibilityLabel={t("prompts.editor.name")}
          initialValue={target.initial.name}
          onChangeText={model.setName}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
        />
      </Field>
      <Field label={t("prompts.editor.text")} error={textError} testID="prompt-editor-text-field">
        <FormTextInput
          testID="prompt-editor-text"
          accessibilityLabel={t("prompts.editor.text")}
          initialValue={target.initial.text}
          onChangeText={model.setText}
          style={styles.multiline}
          multiline
          textAlignVertical="top"
        />
      </Field>
      <SelectField
        label={t("prompts.editor.project")}
        value={state.projectId}
        selectedDisplay={selectedDisplay}
        options={projectOptions}
        onChange={handleProject}
        getValueKey={getProjectKey}
        placeholder={t("prompts.allProjects")}
        emptyText={t("prompts.allProjects")}
        testID="prompt-editor-project"
      />
      {state.submitError ? (
        <Text style={styles.error} accessibilityRole="alert" testID="prompt-editor-error">
          {state.submitError}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  multiline: {
    minHeight: theme.spacing[32],
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
