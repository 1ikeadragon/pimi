import type { TFunction } from "i18next";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { useVaultSummary, type VaultSummary } from "./use-vault";

export function vaultSummaryLabel(summary: VaultSummary, t: TFunction): string {
  if (summary.kind === "waiting")
    return t("settings.vault.state.waiting", { count: summary.count });
  return t(`settings.vault.state.${summary.kind}`);
}

/** The vault's state as the trailing text of the Settings sidebar row that opens it. */
export function VaultSidebarState({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const summary = useVaultSummary(serverId);
  if (!summary) return null;
  return (
    <Text
      style={summary.kind === "waiting" ? styles.waiting : styles.state}
      numberOfLines={1}
      testID="settings-vault-state"
    >
      {vaultSummaryLabel(summary, t)}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  state: {
    flexShrink: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  waiting: {
    flexShrink: 0,
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.sm,
  },
}));
