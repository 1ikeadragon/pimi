import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { PASSWORDS_IMPORT_SUPPORTED, PasswordsImport } from "./import/import-file";

// The host's platform is not sent to the app, and the Passwords export sits on the machine the
// app runs on, so the row follows the client: a Mac running the desktop app or the web app.
function isMacClient(): boolean {
  return isWeb && typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

interface AppleSectionProps {
  serverId: string;
  operator: boolean;
}

export function AppleSection({ serverId, operator }: AppleSectionProps) {
  const { t } = useTranslation();
  const [importing, setImporting] = useState(false);
  const open = useCallback(() => setImporting(true), []);
  const close = useCallback(() => setImporting(false), []);
  if (!isMacClient()) return null;
  return (
    <View style={styles.stack} testID="vault-apple">
      <Text style={settingsStyles.rowTitle}>{t("settings.vault.apple.title")}</Text>
      <SettingsCard>
        <View style={styles.body}>
          <Text style={settingsStyles.rowHint}>{t("settings.vault.apple.body")}</Text>
          {PASSWORDS_IMPORT_SUPPORTED && !importing ? (
            <View style={styles.action}>
              <Button variant="outline" onPress={open} testID="vault-apple-import">
                {t("settings.vault.apple.import")}
              </Button>
            </View>
          ) : null}
        </View>
      </SettingsCard>
      {importing ? (
        <PasswordsImport serverId={serverId} operator={operator} onClose={close} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing[2], marginBottom: theme.spacing[6] },
  action: { alignSelf: "flex-start" },
  body: { gap: theme.spacing[3], padding: theme.spacing[4] },
}));
