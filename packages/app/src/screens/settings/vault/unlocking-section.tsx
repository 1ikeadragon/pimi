import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { VaultStatus } from "@pimi/protocol/vault/types";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useTranslation } from "@/i18n/use-translation";
import { settingsStyles } from "@/styles/settings";
import { useCanUseTouchId, useVaultAction, vaultErrorMessage } from "./use-vault";

// Minutes the vault may sit unused before it locks itself; 0 keeps it unlocked until the daemon
// restarts. Longer means decrypted secrets stay in daemon memory longer.
const IDLE_LOCK_CHOICES = [15, 60, 480, 0] as const;

interface UnlockingSectionProps {
  serverId: string;
  status: VaultStatus;
  operator: boolean;
}

function useIdleLockLabel(): (minutes: number) => string {
  const { t } = useTranslation();
  return useCallback(
    (minutes: number) => {
      if (minutes === 0) return t("settings.vault.unlocking.untilRestart");
      if (minutes >= 60) {
        return t("settings.vault.unlocking.hours", { count: minutes / 60 });
      }
      return t("settings.vault.unlocking.minutes", { count: minutes });
    },
    [t],
  );
}

export function UnlockingSection({ serverId, status, operator }: UnlockingSectionProps) {
  const { t } = useTranslation();
  const canUseTouchId = useCanUseTouchId(serverId);
  const lock = useVaultAction(serverId, (client, _input: null) => client.vaultLock());
  const handleLock = useCallback(() => lock.mutate(null), [lock]);
  return (
    <SettingsSection title={t("settings.vault.unlocking.title")} info={t("settings.vault.info")}>
      <SettingsCard testID="vault-unlocking">
        <SettingsRow
          label={t("settings.vault.unlocking.unlocked")}
          hint={
            status.idleLockAt
              ? t("settings.vault.unlocking.locksAt", {
                  when: new Date(status.idleLockAt).toLocaleTimeString(),
                })
              : undefined
          }
          error={lock.error ? vaultErrorMessage(lock.error) : undefined}
        >
          <Button variant="outline" onPress={handleLock} disabled={lock.isPending}>
            {t("settings.vault.unlocking.lock")}
          </Button>
        </SettingsRow>
        <IdleLockRow serverId={serverId} />
        {canUseTouchId && status.quickUnlock !== "unavailable" ? (
          <TouchIdRow
            serverId={serverId}
            enrolled={status.quickUnlock === "on"}
            operator={operator}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function IdleLockRow({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const label = useIdleLockLabel();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const current = config?.vault.idleLockMinutes ?? 15;
  const choose = useCallback(
    (minutes: number) => {
      void patchConfig({ vault: { idleLockMinutes: minutes } });
    },
    [patchConfig],
  );
  return (
    <SettingsRow
      label={t("settings.vault.unlocking.lockAfter")}
      hint={current === 0 ? t("settings.vault.unlocking.untilRestartHint") : undefined}
    >
      <DropdownMenu>
        <DropdownTrigger
          accessibilityRole="button"
          accessibilityLabel={t("settings.vault.unlocking.lockAfter")}
          testID="vault-idle-lock"
        >
          {label(current)}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {IDLE_LOCK_CHOICES.map((minutes) => (
            <IdleLockOption
              key={minutes}
              minutes={minutes}
              selected={minutes === current}
              label={label(minutes)}
              onChoose={choose}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}

function IdleLockOption({
  minutes,
  selected,
  label,
  onChoose,
}: {
  minutes: number;
  selected: boolean;
  label: string;
  onChoose: (minutes: number) => void;
}) {
  const select = useCallback(() => onChoose(minutes), [minutes, onChoose]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select} testID={`vault-idle-lock-${minutes}`}>
      {label}
    </DropdownMenuItem>
  );
}

function TouchIdRow({
  serverId,
  enrolled,
  operator,
}: {
  serverId: string;
  enrolled: boolean;
  operator: boolean;
}) {
  const { t } = useTranslation();
  const enable = useVaultAction(serverId, (client, _input: null) =>
    client.vaultQuickUnlockEnable(),
  );
  const disable = useVaultAction(serverId, (client, _input: null) =>
    client.vaultQuickUnlockDisable(),
  );
  const toggle = useCallback(() => {
    if (enrolled) disable.mutate(null);
    else enable.mutate(null);
  }, [disable, enable, enrolled]);
  const error = enable.error ?? disable.error;
  return (
    <SettingsRow
      label={t("settings.vault.unlocking.touchId")}
      hint={t("settings.vault.unlocking.touchIdHint")}
      error={error ? vaultErrorMessage(error) : undefined}
    >
      <View style={styles.trailing}>
        {enrolled ? (
          <Text style={settingsStyles.rowHint}>{t("settings.vault.unlocking.touchIdOn")}</Text>
        ) : null}
        <Button
          variant="outline"
          onPress={toggle}
          disabled={!operator || enable.isPending || disable.isPending}
          testID="vault-touch-id-toggle"
        >
          {enrolled
            ? t("settings.vault.unlocking.touchIdDisable")
            : t("settings.vault.unlocking.touchIdEnable")}
        </Button>
      </View>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  trailing: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
}));
