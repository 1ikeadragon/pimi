import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PackageRunEntry } from "@pimi/protocol/messages";
import {
  DEFAULT_PACKAGE_POLICY,
  PACKAGE_POLICY_MIN_AGE_DAYS_MAX,
  PACKAGE_POLICY_MIN_AGE_DAYS_MIN,
  type PackagePolicy,
  type PackagePolicyMode,
} from "@pimi/protocol/package-runner-policy";
import {
  SettingsCard,
  SettingsCollapsibleRow,
  SettingsRow,
  SettingsSection,
} from "@/components/settings";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useFetchQuery } from "@/data/query";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
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
  const [saving, setSaving] = useState(false);
  const policy: PackagePolicy = config?.supplyChain ?? DEFAULT_PACKAGE_POLICY;

  const save = useCallback(
    (next: PackagePolicy) => {
      if (saving) return;
      setError(null);
      setSaving(true);
      void patchConfig({ supplyChain: next })
        .catch((failure: unknown) => {
          setError(failure instanceof Error ? failure.message : String(failure));
        })
        .finally(() => setSaving(false));
    },
    [patchConfig, saving],
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
      { value: "pinned", label: t("settings.supplyChain.modes.pinned"), disabled: saving },
      { value: "minAge", label: t("settings.supplyChain.modes.minAge"), disabled: saving },
      { value: "latest", label: t("settings.supplyChain.modes.latest"), disabled: saving },
    ],
    [t, saving],
  );

  if (!isConnected || !config) return null;

  const hint = t(`settings.supplyChain.hints.${policy.mode}`, { count: policy.minAgeDays });

  return (
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
                disabled={saving || policy.minAgeDays <= PACKAGE_POLICY_MIN_AGE_DAYS_MIN}
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
                disabled={saving || policy.minAgeDays >= PACKAGE_POLICY_MIN_AGE_DAYS_MAX}
                accessibilityLabel={t("settings.supplyChain.moreDays")}
                testID="supply-chain-days-increase"
              >
                +
              </Button>
            </View>
          </SettingsRow>
        ) : null}
        <PackageInventory
          serverId={serverId}
          policy={policy}
          providersKey={JSON.stringify(config.providers)}
        />
      </SettingsCard>
      {error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {error}
        </Text>
      ) : null}
      <Text style={styles.footnote}>{t("settings.supplyChain.footnote")}</Text>
    </SettingsSection>
  );
}

function PackageInventory({
  serverId,
  policy,
  providersKey,
}: {
  serverId: string;
  policy: PackagePolicy;
  providersKey: string;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // The daemon applies the policy and reads its npx cache; the app only renders the answer.
  const runs = useFetchQuery({
    dataShape: "value",
    queryKey: ["supply-chain-packages", serverId, policy.mode, policy.minAgeDays, providersKey],
    queryFn: () => client!.getPackageRuns(),
    enabled: Boolean(client) && isConnected,
    staleTimeMs: 0,
    retry: false,
  });
  const packages = runs.data ?? [];
  const { refetch } = runs;
  const refresh = useCallback(() => void refetch(), [refetch]);
  let packageSummary = String(packages.length);
  if (runs.isError) packageSummary = t("settings.supplyChain.unavailable");
  if (runs.isFetching) packageSummary = t("settings.supplyChain.checking");

  return (
    <SettingsCollapsibleRow
      label={t("settings.supplyChain.packages")}
      hint={t("settings.supplyChain.packageScope")}
      summary={packageSummary}
      testID="supply-chain-packages"
    >
      <SettingsRow
        label={t("settings.supplyChain.inventory")}
        hint={t("settings.supplyChain.inventoryHint")}
      >
        <Button
          variant="ghost"
          onPress={refresh}
          disabled={runs.isFetching}
          testID="supply-chain-packages-refresh"
        >
          {t("settings.supplyChain.refresh")}
        </Button>
      </SettingsRow>
      {runs.isError ? (
        <SettingsRow
          label={t("settings.supplyChain.loadFailed")}
          error={runs.error instanceof Error ? runs.error.message : String(runs.error)}
          testID="supply-chain-packages-error"
        />
      ) : null}
      {runs.isPending ? (
        <SettingsRow
          label={t("settings.supplyChain.checking")}
          testID="supply-chain-packages-loading"
        />
      ) : null}
      {!runs.isPending && packages.length === 0 && !runs.isError ? (
        <SettingsRow
          label={t("settings.supplyChain.empty")}
          hint={t("settings.supplyChain.emptyHint")}
          testID="supply-chain-packages-empty"
        />
      ) : null}
      {!runs.isPending && !runs.isError
        ? packages.map((entry) => <PackageRow key={entry.id} entry={entry} policy={policy} />)
        : null}
    </SettingsCollapsibleRow>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

function packageStatus(t: Translate, entry: PackageRunEntry): string {
  if (!entry.managed) return t("settings.supplyChain.package.notManaged");
  if (entry.pinnedVersion) {
    return t("settings.supplyChain.package.pinned", { version: entry.pinnedVersion });
  }
  if (entry.cutoff) {
    return t("settings.supplyChain.package.newestBefore", { date: formatCutoff(entry.cutoff) });
  }
  return t("settings.supplyChain.package.latest");
}

function policyExplanation(t: Translate, entry: PackageRunEntry, policy: PackagePolicy): string {
  const date = entry.cutoff ? formatCutoff(entry.cutoff) : "";
  switch (entry.reason) {
    case "unmanaged":
      return t("settings.supplyChain.detail.why.unmanaged");
    case "exactVersion":
      return t("settings.supplyChain.detail.why.exactVersion");
    case "commandDateFlag":
      return t("settings.supplyChain.detail.why.commandDateFlag", { date });
    case "policy":
      return t(`settings.supplyChain.detail.why.${policy.mode}`, {
        date,
        count: policy.minAgeDays,
      });
  }
}

function installedLine(t: Translate, entry: PackageRunEntry): string {
  if (!entry.installedKnown) {
    return t("settings.supplyChain.detail.runningUnknown", { runner: entry.runner });
  }
  if (!entry.installed) return t("settings.supplyChain.detail.notRunYet");
  return t("settings.supplyChain.detail.runningVersion", {
    version: entry.installed.version,
    date: new Date(entry.installed.installedAtMs).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
  });
}

const PackageRow = memo(function PackageRow({
  entry,
  policy,
}: {
  entry: PackageRunEntry;
  policy: PackagePolicy;
}) {
  const { t } = useTranslation();
  const used = t(`settings.supplyChain.detail.usedBy.${entry.kind}`, { label: entry.label });
  const configuredCommand = useMemo(
    () => (
      <Text selectable style={styles.command}>
        {JSON.stringify(entry.configuredCommand)}
      </Text>
    ),
    [entry.configuredCommand],
  );
  const effectiveCommand = useMemo(
    () => (
      <Text selectable style={styles.command}>
        {JSON.stringify(entry.effectiveCommand)}
      </Text>
    ),
    [entry.effectiveCommand],
  );
  return (
    <SettingsCollapsibleRow
      label={entry.name ?? entry.label}
      hint={entry.runner}
      summary={packageStatus(t, entry)}
      testID={`supply-chain-package-${entry.id}`}
    >
      <SettingsRow
        label={t("settings.supplyChain.detail.policy")}
        hint={policyExplanation(t, entry, policy)}
      />
      <SettingsRow
        label={t("settings.supplyChain.detail.requested")}
        hint={entry.requestedSpec ?? entry.configuredCommand.join(" ")}
      />
      <SettingsRow
        label={t("settings.supplyChain.detail.running")}
        hint={installedLine(t, entry)}
      />
      <SettingsRow label={t("settings.supplyChain.detail.configured")} hint={configuredCommand} />
      <SettingsRow label={t("settings.supplyChain.detail.effective")} hint={effectiveCommand} />
      <SettingsRow
        label={t("settings.supplyChain.detail.evidence")}
        hint={t("settings.supplyChain.detail.evidenceHint")}
      />
      <SettingsRow label={t("settings.supplyChain.detail.usedByLabel")} hint={used} />
    </SettingsCollapsibleRow>
  );
});

const styles = StyleSheet.create((theme) => ({
  command: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
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
