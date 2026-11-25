import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { ImportRows, type ImportCandidate, type ImportResult } from "./import-rows";
import { parseEnv } from "./parse-env";

interface EnvPasteImportProps {
  serverId: string;
  operator: boolean;
  onAdded: () => void;
  onClose: () => void;
}

/** Pasted `.env` lines, read as you type. The text lives only in this component. */
export function EnvPasteImport({ serverId, operator, onAdded, onClose }: EnvPasteImportProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const parsed = useMemo(() => parseEnv(text), [text]);
  const candidates = useMemo<ImportCandidate[]>(
    () =>
      parsed.lines.map((line, index) => ({
        id: `${index}:${line.variable}`,
        label: line.variable,
        variable: line.variable,
        value: line.value,
      })),
    [parsed],
  );
  const [addedCount, setAddedCount] = useState(0);
  const edit = useCallback((value: string) => {
    setText(value);
    setAddedCount(0);
  }, []);
  const added = useCallback(
    (result: ImportResult) => {
      setAddedCount(result.count);
      if (result.complete) {
        setText("");
        setResetKey((key) => key + 1);
      }
      onAdded();
    },
    [onAdded],
  );
  return (
    <View style={[settingsStyles.card, styles.form]} testID="vault-import-env">
      <Field label={t("settings.vault.import.envLabel")}>
        <FormTextInput
          initialValue=""
          resetKey={resetKey}
          onChangeText={edit}
          multiline
          numberOfLines={5}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("settings.vault.import.envPlaceholder")}
          accessibilityLabel={t("settings.vault.import.envLabel")}
          testID="vault-import-env-text"
        />
      </Field>
      {parsed.skipped > 0 ? (
        <Text style={settingsStyles.rowHint} testID="vault-import-skipped">
          {t("settings.vault.import.skipped", { count: parsed.skipped })}
        </Text>
      ) : null}
      {candidates.length > 0 ? (
        <ImportRows
          serverId={serverId}
          operator={operator}
          candidates={candidates}
          defaultSelected
          onAdded={added}
        />
      ) : null}
      {addedCount > 0 ? (
        <>
          <Text style={settingsStyles.rowHint}>
            {t("settings.vault.import.added", { count: addedCount })}
          </Text>
          <Text style={settingsStyles.rowHint} testID="vault-import-after">
            {t("settings.vault.import.envAfter")}
          </Text>
        </>
      ) : null}
      <Button variant="outline" onPress={onClose}>
        {t("settings.vault.import.close")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[3], padding: theme.spacing[4] },
}));
