import { useCallback } from "react";
import { useRouter } from "expo-router";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/use-translation";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { useVaultSummary } from "./use-vault";
import { vaultSummaryLabel } from "./vault-state";

/** Vault on the Trust & access page: where it stands, and the way into its own page. */
export function VaultSummaryRow({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const summary = useVaultSummary(serverId);
  const open = useCallback(
    () => router.push(buildSettingsHostSectionRoute(serverId, "vault")),
    [router, serverId],
  );
  return (
    <SettingsCard testID="trust-vault-summary">
      <SettingsRow
        label={t("settings.vault.enable")}
        hint={summary ? vaultSummaryLabel(summary, t) : undefined}
      >
        <Button variant="outline" onPress={open} testID="trust-vault-open">
          {t("settings.trust.vaultOpen")}
        </Button>
      </SettingsRow>
    </SettingsCard>
  );
}
