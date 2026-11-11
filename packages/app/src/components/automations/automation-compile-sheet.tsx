import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AutomationDefinition } from "@pimi/protocol/automation/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { buildAutomationProjectTargets } from "@/automations/automation-project-targets";
import { useAutomationMutations } from "@/hooks/use-automation-mutations";
import { useProjects } from "@/hooks/use-projects";
import { toErrorMessage } from "@/utils/error-messages";

export interface CompiledAutomationDraft {
  serverId: string;
  definition: AutomationDefinition;
}

interface AutomationCompileSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Opens the automation form on the compiled draft. */
  onCompiled: (draft: CompiledAutomationDraft) => void;
}

/**
 * "Describe it": the host's LLM turns a plain-text description into a step graph, which opens in
 * the automation form for review. Nothing is saved here.
 */
export function AutomationCompileSheet({
  visible,
  onClose,
  onCompiled,
}: AutomationCompileSheetProps): ReactElement {
  const { projects } = useProjects();
  const targets = useMemo(() => buildAutomationProjectTargets(projects), [projects]);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((candidate) => candidate.optionId === optionId) ?? null;
  const { compileAutomation, isCompiling } = useAutomationMutations({
    serverId: target?.serverId ?? "",
  });
  const options = useMemo<SelectFieldOption<string>[]>(
    () =>
      targets.map((candidate) => ({
        id: candidate.optionId,
        value: candidate.optionId,
        label: candidate.projectName,
        description: candidate.serverName,
      })),
    [targets],
  );
  const selectedDisplay = useMemo<SelectFieldDisplay | null>(
    () => (target ? { label: target.projectName } : null),
    [target],
  );
  const canCompile = Boolean(target && description.trim()) && !isCompiling;
  const handleCompile = useCallback(async () => {
    if (!target || !description.trim()) {
      return;
    }
    setError(null);
    try {
      const definition = await compileAutomation({
        description: description.trim(),
        cwd: target.cwd,
      });
      onCompiled({ serverId: target.serverId, definition });
    } catch (compileError) {
      setError(toErrorMessage(compileError));
    }
  }, [compileAutomation, description, onCompiled, target]);
  const handleCompilePress = useCallback(() => void handleCompile(), [handleCompile]);
  const header = useMemo<SheetHeader>(() => ({ title: "Describe an automation" }), []);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button style={styles.footerButton} variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleCompilePress}
          disabled={!canCompile}
          loading={isCompiling}
          testID="automation-compile-submit"
        >
          Compile
        </Button>
      </View>
    ),
    [canCompile, handleCompilePress, isCompiling, onClose],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      testID="automation-compile-sheet"
    >
      <SelectField
        label="Project"
        value={optionId}
        selectedDisplay={selectedDisplay}
        options={options}
        onChange={setOptionId}
        placeholder="Select project"
        emptyText="No projects found"
        searchable
        searchPlaceholder="Search projects..."
        title="Select project"
        triggerTestID="automation-compile-project"
      />
      <Field
        label="What should happen, and when?"
        hint="For example: when a pull request opens in owner/repo, review it; if the review finds a bug, write a fix in a worktree."
      >
        <FormTextInput
          testID="automation-compile-description"
          accessibilityLabel="Description"
          initialValue={description}
          onChangeText={setDescription}
          placeholder="Every weekday at 9am, …"
          style={styles.multilineInput}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
        />
      </Field>
      {isCompiling ? <Text style={styles.note}>Compiling. This can take a minute.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  multilineInput: {
    minHeight: 120,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
