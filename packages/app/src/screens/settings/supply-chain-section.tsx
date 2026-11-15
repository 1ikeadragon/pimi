import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProviderOverrideSchema } from "@pimi/protocol/provider-config";
import {
  applyPackagePolicy,
  DEFAULT_PACKAGE_POLICY,
  PACKAGE_POLICY_MIN_AGE_DAYS_MAX,
  PACKAGE_POLICY_MIN_AGE_DAYS_MIN,
  type PackagePolicy,
  type PackagePolicyMode,
  type PackagePolicyResult,
} from "@pimi/protocol/package-runner-policy";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

function formatCutoff(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function SupplyChainSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [error, setError] = useState<string | null>(null);
  const policy: PackagePolicy = config?.supplyChain ?? DEFAULT_PACKAGE_POLICY;

  const save = useCallback(
    (next: PackagePolicy) => {
      setError(null);
      patchConfig({ supplyChain: next }).catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
    },
    [patchConfig],
  );
  const changeMode = useCallback(
    (mode: PackagePolicyMode) => save({ ...policy, mode }),
    [save, policy],
  );
  const decrease = useCallback(
    () =>
      save({
        ...policy,
        minAgeDays: Math.max(PACKAGE_POLICY_MIN_AGE_DAYS_MIN, policy.minAgeDays - 1),
      }),
    [save, policy],
  );
  const increase = useCallback(
    () =>
      save({
        ...policy,
        minAgeDays: Math.min(PACKAGE_POLICY_MIN_AGE_DAYS_MAX, policy.minAgeDays + 1),
      }),
    [save, policy],
  );

  const options = useMemo<SegmentedControlOption<PackagePolicyMode>[]>(
    () => [
      { value: "pinned", label: t("settings.supplyChain.modes.pinned") },
      { value: "minAge", label: t("settings.supplyChain.modes.minAge") },
      { value: "latest", label: t("settings.supplyChain.modes.latest") },
    ],
    [t],
  );

  const packages = useMemo(() => {
    const now = Date.now();
    const rows: { id: string; label: string; result: PackagePolicyResult }[] = [];
    for (const [id, raw] of Object.entries(config?.providers ?? {})) {
      const parsed = ProviderOverrideSchema.safeParse(raw);
      const command = parsed.success ? parsed.data.command : undefined;
      if (!command) continue;
      const result = applyPackagePolicy(command, policy, now);
      if (!result.managed) {
        // Only runners Pimi recognises are listed, plus any other runner it leaves alone.
        if (!["npx", "uvx", "bunx", "pnpm"].includes(command[0])) continue;
      }
      rows.push({ id, label: parsed.data?.label ?? id, result });
    }
    return rows;
  }, [config?.providers, policy]);

  if (!isConnected || !config) return null;

  const hint = t(`settings.supplyChain.hints.${policy.mode}`, { count: policy.minAgeDays });

  return (
    <>
      <SettingsSection title={t("settings.supplyChain.title")} testID="host-page-supply-chain">
        <SettingsCard>
          <SettingsRow
            label={t("settings.supplyChain.updates")}
            hint={hint}
            settingId="providers.supplyChain"
          >
            <SegmentedControl
              options={options}
              value={policy.mode}
              onValueChange={changeMode}
              accessibilityLabel={t("settings.supplyChain.updates")}
              testID="supply-chain-mode"
            />
          </SettingsRow>
          {policy.mode === "minAge" ? (
            <SettingsRow label={t("settings.supplyChain.days")}>
              <View style={styles.stepper}>
                <Button
                  variant="outline"
                  onPress={decrease}
                  disabled={policy.minAgeDays <= PACKAGE_POLICY_MIN_AGE_DAYS_MIN}
                  accessibilityLabel={t("settings.supplyChain.fewerDays")}
                  testID="supply-chain-days-decrease"
                >
                  -
                </Button>
                <Text style={styles.stepperValue} testID="supply-chain-days-value">
                  {policy.minAgeDays}
                </Text>
                <Button
                  variant="outline"
                  onPress={increase}
                  disabled={policy.minAgeDays >= PACKAGE_POLICY_MIN_AGE_DAYS_MAX}
                  accessibilityLabel={t("settings.supplyChain.moreDays")}
                  testID="supply-chain-days-increase"
                >
                  +
                </Button>
              </View>
            </SettingsRow>
          ) : null}
        </SettingsCard>
        {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
        <Text style={styles.footnote}>{t("settings.supplyChain.footnote")}</Text>
      </SettingsSection>
      {packages.length > 0 ? (
        <SettingsSection title={t("settings.supplyChain.packages")} testID="supply-chain-packages">
          <SettingsCard>
            {packages.map(({ id, label, result }) => (
              <SettingsRow
                key={id}
                label={label}
                hint={packageHint(t, result)}
                testID={`supply-chain-package-${id}`}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}

function packageHint(t: ReturnType<typeof useTranslation>["t"], result: PackagePolicyResult) {
  if (!result.managed) return t("settings.supplyChain.package.notManaged");
  if (result.pinnedVersion) {
    return t("settings.supplyChain.package.pinned", { version: result.pinnedVersion });
  }
  if (result.cutoff) {
    return t("settings.supplyChain.package.newestBefore", { date: formatCutoff(result.cutoff) });
  }
  return t("settings.supplyChain.package.latest");
}

const styles = StyleSheet.create((theme) => ({
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  stepperValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    minWidth: 28,
    textAlign: "center",
  },
  footnote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
    marginHorizontal: theme.spacing[1],
  },
}));
