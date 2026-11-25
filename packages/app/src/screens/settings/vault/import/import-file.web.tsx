import { useCallback, useMemo, useState, type ChangeEvent } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { ImportRows, type ImportCandidate, type ImportResult } from "./import-rows";
import { envNameFromParts } from "../secret-names";
import { parsePasswordsExport, type PasswordsParse } from "./parse-csv";

interface PasswordsImportProps {
  serverId: string;
  operator: boolean;
  onClose: () => void;
}

export const PASSWORDS_IMPORT_SUPPORTED = true;

function hostOf(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

/** A Passwords app export (CSV), read in the browser. Rows are listed, none chosen. */
export function PasswordsImport({ serverId, operator, onClose }: PasswordsImportProps) {
  const { t } = useTranslation();
  const [parse, setParse] = useState<PasswordsParse | null>(null);
  const [addedCount, setAddedCount] = useState(0);
  const read = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setAddedCount(0);
    void file.text().then((text) => setParse(parsePasswordsExport(text)));
  }, []);
  const candidates = useMemo<ImportCandidate[]>(() => {
    if (parse?.kind !== "rows") return [];
    return parse.rows.map((row, index) => {
      const title = row.title || hostOf(row.url) || t("settings.vault.import.untitled");
      return {
        id: String(index),
        label: row.username
          ? t("settings.vault.import.csvRowLabel", { title, username: row.username })
          : title,
        variable: envNameFromParts(title),
        value: row.password,
      };
    });
  }, [parse, t]);
  const added = useCallback((result: ImportResult) => {
    setAddedCount(result.count);
    if (result.complete) setParse(null);
  }, []);
  return (
    <View style={[settingsStyles.card, styles.form]} testID="vault-import-csv">
      <Text style={settingsStyles.rowHint}>{t("settings.vault.import.csvPick")}</Text>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={read}
        data-testid="vault-import-csv-file"
      />
      {parse?.kind === "no_password_column" ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {t("settings.vault.import.csvNoPassword")}
        </Text>
      ) : null}
      {parse?.kind === "rows" && candidates.length === 0 ? (
        <Text style={settingsStyles.rowHint}>{t("settings.vault.import.csvEmpty")}</Text>
      ) : null}
      {candidates.length > 0 ? (
        <ImportRows
          serverId={serverId}
          operator={operator}
          candidates={candidates}
          defaultSelected={false}
          onAdded={added}
        />
      ) : null}
      {addedCount > 0 ? (
        <>
          <Text style={settingsStyles.rowHint}>
            {t("settings.vault.import.added", { count: addedCount })}
          </Text>
          <Text style={settingsStyles.rowHint} testID="vault-import-after">
            {t("settings.vault.import.csvAfter")}
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
