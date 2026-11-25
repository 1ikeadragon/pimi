import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { VaultAuditEntry } from "@pimi/protocol/vault/types";
import { SettingsCard } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";

export function AuditSection({ entries }: { entries: VaultAuditEntry[] }) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("settings.vault.audit.title")}>
      <SettingsCard testID="vault-audit">
        {entries.length === 0 ? (
          <View style={styles.row}>
            <Text style={settingsStyles.rowHint}>{t("settings.vault.audit.empty")}</Text>
          </View>
        ) : (
          entries.map((entry) => (
            <View key={`${entry.at}-${entry.event}-${entry.detail}`} style={styles.row}>
              <Text style={styles.detail} selectable>
                {entry.detail}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {`${entry.event} · ${new Date(entry.at).toLocaleString()}${entry.agentId ? ` · ${entry.agentId}` : ""}`}
              </Text>
            </View>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    padding: theme.spacing[4],
    gap: theme.spacing[1],
  },
  detail: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
