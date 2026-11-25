import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { VaultRequest } from "@pimi/protocol/vault/types";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { VaultRequestCard } from "@/components/vault/vault-request-card";
import { useTranslation } from "@/i18n/use-translation";

interface RequestsSectionProps {
  serverId: string;
  requests: VaultRequest[];
}

export function RequestsSection({ serverId, requests }: RequestsSectionProps) {
  const { t } = useTranslation();
  if (requests.length === 0) return null;
  return (
    <SettingsSection title={t("settings.vault.requests.title")}>
      <View style={styles.list} testID="vault-requests">
        {requests.map((request) => (
          <VaultRequestCard key={request.id} serverId={serverId} request={request} />
        ))}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.spacing[3] },
}));
