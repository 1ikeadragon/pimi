import { useCallback, type ReactElement } from "react";
import { useRouter } from "expo-router";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/i18n/use-translation";
import { useSettingsFocusStore } from "@/settings-index/focus";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { useVaultSummary } from "./use-vault";

/**
 * The chat menu's way into the vault, shown whether or not the vault is on, so a feature that is
 * off by default can still be found where agents run. It reads the vault only while the menu is open.
 */
export function VaultMenuItem({ serverId, leading }: { serverId: string; leading: ReactElement }) {
  const { t } = useTranslation();
  const router = useRouter();
  const summary = useVaultSummary(serverId);
  const waiting = summary?.kind === "waiting" ? summary.count : 0;
  const isOff = summary === null || summary.kind === "off";
  const open = useCallback(() => {
    if (isOff) useSettingsFocusStore.getState().focusSetting("vault.enabled");
    else if (waiting > 0) useSettingsFocusStore.getState().focusSetting("vault.requests");
    router.push(buildSettingsHostSectionRoute(serverId, "vault"));
  }, [isOff, router, serverId, waiting]);
  return (
    <DropdownMenuItem testID="workspace-header-vault" leading={leading} onSelect={open}>
      {waiting > 0
        ? t("settings.vault.menu.review", { count: waiting })
        : t("settings.vault.menu.open")}
    </DropdownMenuItem>
  );
}
