import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";

export interface LanguageServerDraft {
  command: string;
  /** Arguments separated by spaces. */
  args: string;
}

export function parseServerArgs(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

interface TestOutcome {
  ok: boolean;
  message: string;
}

/** Sets the server Pimi uses for one language, in place of the one it detects. */
export function LanguageServerModal({
  visible,
  language,
  initialDraft,
  onClose,
  onSave,
  onTest,
}: {
  visible: boolean;
  language: string;
  initialDraft: LanguageServerDraft;
  onClose: () => void;
  onSave: (draft: LanguageServerDraft) => Promise<void>;
  onTest: (draft: LanguageServerDraft) => Promise<TestOutcome>;
}) {
  const { t } = useTranslation();
  const [command, setCommand] = useState(initialDraft.command);
  const [args, setArgs] = useState(initialDraft.args);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [pending, setPending] = useState<"save" | "test" | null>(null);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.languageServers.modal.title", { language }) }),
    [language, t],
  );

  useEffect(() => {
    if (!visible) return;
    setCommand(initialDraft.command);
    setArgs(initialDraft.args);
    setError(null);
    setOutcome(null);
    setPending(null);
  }, [visible, initialDraft.command, initialDraft.args]);

  const handleCommandChange = useCallback((value: string) => {
    setCommand(value);
    setError(null);
    setOutcome(null);
  }, []);
  const handleArgsChange = useCallback((value: string) => {
    setArgs(value);
    setOutcome(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (pending) return;
    if (!command.trim()) {
      setError(t("settings.languageServers.modal.commandRequired"));
      return;
    }
    setPending("save");
    try {
      await onSave({ command: command.trim(), args });
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.replace(/^Request failed: /, "").replace(/ requestType=\S+.*$/, "")
          : t("common.errors.unableToSave"),
      );
    } finally {
      setPending(null);
    }
  }, [args, command, onClose, onSave, pending, t]);

  const handleTest = useCallback(async () => {
    if (pending) return;
    if (!command.trim()) {
      setError(t("settings.languageServers.modal.commandRequired"));
      return;
    }
    setPending("test");
    setOutcome(null);
    try {
      setOutcome(await onTest({ command: command.trim(), args }));
    } finally {
      setPending(null);
    }
  }, [args, command, onTest, pending, t]);

  const handleSaveVoid = useCallback(() => void handleSave(), [handleSave]);
  const handleTestVoid = useCallback(() => void handleTest(), [handleTest]);
  const handleCancel = useCallback(() => {
    if (!pending) onClose();
  }, [onClose, pending]);
  const resetKey = visible ? "open" : "closed";

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={header}
      onClose={handleCancel}
      testID="language-server-modal"
      desktopMaxWidth={480}
    >
      <View style={styles.body}>
        <Field
          label={t("settings.languageServers.modal.command")}
          hint={t("settings.languageServers.modal.commandHint")}
          error={error ?? undefined}
        >
          <FormTextInput
            initialValue={initialDraft.command}
            resetKey={resetKey}
            onChangeText={handleCommandChange}
            placeholder={t("settings.languageServers.modal.commandPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={pending === null}
            accessibilityLabel={t("settings.languageServers.modal.command")}
            testID="language-server-command-input"
          />
        </Field>
        <Field
          label={t("settings.languageServers.modal.args")}
          hint={t("settings.languageServers.modal.argsHint")}
        >
          <FormTextInput
            initialValue={initialDraft.args}
            resetKey={resetKey}
            onChangeText={handleArgsChange}
            placeholder="--stdio"
            autoCapitalize="none"
            autoCorrect={false}
            editable={pending === null}
            onSubmitEditing={handleSaveVoid}
            accessibilityLabel={t("settings.languageServers.modal.args")}
            testID="language-server-args-input"
          />
        </Field>
        {outcome ? (
          <Text
            style={outcome.ok ? styles.success : styles.failure}
            testID="language-server-modal-test-result"
          >
            {outcome.message}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.action}
            onPress={handleTestVoid}
            disabled={pending !== null}
            testID="language-server-modal-test"
          >
            {pending === "test"
              ? t("settings.languageServers.testing")
              : t("settings.languageServers.test")}
          </Button>
          <Button
            variant="default"
            style={styles.action}
            onPress={handleSaveVoid}
            disabled={pending !== null}
            testID="language-server-modal-save"
          >
            {pending === "save"
              ? t("settings.languageServers.modal.saving")
              : t("settings.languageServers.modal.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4], paddingBottom: theme.spacing[2] },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  action: { flex: 1 },
  success: { color: theme.colors.palette.green[400], fontSize: theme.fontSize.base },
  failure: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.base },
}));
