import { useCallback, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useTranslation } from "@/i18n/use-translation";
import { TASK_TITLE_MAX_LENGTH } from "@pimi/protocol/task/types";

/**
 * The list's first row: type a title, press Enter, get a `todo`. The field keeps focus so a run of
 * tasks is one continuous motion.
 */
export function TaskQuickAdd({
  onSubmit,
  testID,
}: {
  onSubmit: (title: string) => Promise<void>;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [text, setText] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const title = text.trim().slice(0, TASK_TITLE_MAX_LENGTH);
    if (!title || busy) return;
    setBusy(true);
    try {
      await onSubmit(title);
      setText("");
      setResetKey((key) => key + 1);
    } catch {
      // The caller surfaces the failure; the typed title stays so nothing is lost.
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, onSubmit, text]);

  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  return (
    <View style={styles.container}>
      <FormTextInput
        ref={inputRef}
        initialValue=""
        resetKey={resetKey}
        onChangeText={setText}
        onSubmitEditing={handleSubmit}
        placeholder={t("tasks.quickAdd.placeholder")}
        returnKeyType="done"
        blurOnSubmit={false}
        editable={!busy}
        accessibilityLabel={t("tasks.quickAdd.accessibility")}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingBottom: theme.spacing[3],
  },
}));
