import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Pause, Play, Plus, ShieldAlert, Square, Swords, Wallet } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AttackRun } from "@pimi/protocol/attack/types";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import { useAttackStore } from "./attack-store";
import { formatClock, useAttackRuntimeMs } from "./use-attack-run-clock";

function formatKiloTokens(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : `${Math.round(tokens / 1000)}k`;
}

function hostLabel(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

export function AttackRunBar({
  run,
  serverId,
  onNewRun,
  findingsBadge,
}: {
  run: AttackRun;
  serverId: string;
  onNewRun: () => void;
  /** Narrow windows: the findings count, which opens the findings overlay when pressed. */
  findingsBadge?: { count: number; open: boolean; onPress: () => void };
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(
    async (action: "pause" | "resume" | "cancel") => {
      if (!client) return;
      setBusy(true);
      setError(null);
      try {
        let result;
        if (action === "pause") result = await client.attackRunPause({ runId: run.id });
        else if (action === "resume") result = await client.attackRunResume({ runId: run.id });
        else result = await client.attackRunCancel({ runId: run.id });
        useAttackStore.getState().putRun(serverId, result.run);
      } catch (caught) {
        setError(toErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [client, run.id, serverId],
  );
  const onPause = useCallback(() => void act("pause"), [act]);
  const onResume = useCallback(() => void act("resume"), [act]);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const onBudgetDone = useCallback(() => setBudgetOpen(false), []);
  const onToggleBudget = useCallback(() => setBudgetOpen((open) => !open), []);
  const onStop = useCallback(() => void act("cancel"), [act]);
  const runtimeMs = useAttackRuntimeMs(run);
  const active = run.status === "running" || run.status === "paused";
  const budgetSpent = isBudgetSpent(run);
  const timeFraction = Math.min(1, runtimeMs / run.limits.maxRuntimeMs);
  const tokenFraction = Math.min(1, run.spent.tokens / run.limits.maxTokens);
  const statusText =
    run.status === "paused" && run.pausedReason
      ? t(`attack.run.pausedReason.${run.pausedReason}`)
      : t(`attack.run.status.${run.status}`);
  return (
    <View style={styles.bar} testID="attack-run-status">
      <View style={styles.identity}>
        <Swords size={14} color="currentColor" />
        <Text style={styles.target} numberOfLines={1}>
          {hostLabel(run.target)}
        </Text>
        <View style={[styles.statusChip, active ? styles.statusActive : styles.statusEnded]}>
          <Text style={styles.statusText} testID="attack-run-status-text">
            {statusText}
          </Text>
        </View>
      </View>
      <View style={styles.meters}>
        <Meter
          label={t("attack.run.timeSpent", {
            spent: formatClock(runtimeMs),
            limit: Math.floor(run.limits.maxRuntimeMs / 60_000),
          })}
          fraction={timeFraction}
          testID="attack-meter-time"
        />
        <Meter
          label={t("attack.run.tokensSpent", {
            spent: formatKiloTokens(run.spent.tokens),
            limit: formatKiloTokens(run.limits.maxTokens),
          })}
          fraction={tokenFraction}
          testID="attack-meter-tokens"
        />
      </View>
      <View style={styles.buttons}>
        {findingsBadge ? (
          <Button
            size="sm"
            variant={findingsBadge.open ? "default" : "outline"}
            leftIcon={ShieldAlert}
            onPress={findingsBadge.onPress}
            testID="attack-findings-badge"
          >
            {t("attack.run.findingsBadge", { count: findingsBadge.count })}
          </Button>
        ) : null}
        {run.status === "running" ? (
          <Button
            size="sm"
            variant="outline"
            leftIcon={Pause}
            onPress={onPause}
            disabled={busy}
            testID="attack-pause"
          >
            {t("attack.run.pause")}
          </Button>
        ) : null}
        {run.status === "paused" && budgetSpent ? (
          <Button
            size="sm"
            variant={budgetOpen ? "default" : "outline"}
            leftIcon={Wallet}
            onPress={onToggleBudget}
            disabled={busy}
            testID="attack-add-budget"
          >
            {t("attack.run.addBudget")}
          </Button>
        ) : null}
        {run.status === "paused" && !budgetSpent ? (
          <Button
            size="sm"
            variant="outline"
            leftIcon={Play}
            onPress={onResume}
            disabled={busy}
            testID="attack-resume"
          >
            {t("attack.run.resume")}
          </Button>
        ) : null}
        {active ? (
          <Button
            size="sm"
            variant="destructive"
            leftIcon={Square}
            onPress={onStop}
            disabled={busy}
            testID="attack-stop"
          >
            {t("attack.run.stop")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            leftIcon={Plus}
            onPress={onNewRun}
            testID="attack-new-run"
          >
            {t("attack.run.newRun")}
          </Button>
        )}
      </View>
      {run.status === "paused" && budgetSpent && budgetOpen ? (
        <AddBudgetPanel run={run} serverId={serverId} onDone={onBudgetDone} />
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

function isBudgetSpent(run: AttackRun): boolean {
  return (
    run.status === "paused" &&
    (run.pausedReason === "time_budget" ||
      run.pausedReason === "token_budget" ||
      run.spent.runtimeMs >= run.limits.maxRuntimeMs ||
      run.spent.tokens >= run.limits.maxTokens)
  );
}

function AddBudgetPanel({
  run,
  serverId,
  onDone,
}: {
  run: AttackRun;
  serverId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [addMinutes, setAddMinutes] = useState("15");
  const [addKiloTokens, setAddKiloTokens] = useState("500");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onApply = useCallback(async () => {
    if (!client) return;
    const minutes = parseAdded(addMinutes);
    const kiloTokens = parseAdded(addKiloTokens);
    if (minutes === null || kiloTokens === null || (minutes === 0 && kiloTokens === 0)) {
      setError(t("attack.run.addBudgetInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await client.attackRunResume({
        runId: run.id,
        limits: {
          maxRuntimeMs: run.limits.maxRuntimeMs + minutes * 60_000,
          maxTokens: run.limits.maxTokens + kiloTokens * 1000,
        },
      });
      useAttackStore.getState().putRun(serverId, result.run);
      onDone();
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [addKiloTokens, addMinutes, client, onDone, run.id, run.limits, serverId, t]);
  return (
    <View style={styles.budgetPanel} testID="attack-add-budget-panel">
      <View style={styles.budgetField}>
        <Field label={t("attack.run.addMinutes")}>
          <FormTextInput
            size="sm"
            testID="attack-add-minutes"
            accessibilityLabel={t("attack.run.addMinutes")}
            initialValue={addMinutes}
            onChangeText={setAddMinutes}
            keyboardType="number-pad"
          />
        </Field>
      </View>
      <View style={styles.budgetField}>
        <Field label={t("attack.run.addKiloTokens")}>
          <FormTextInput
            size="sm"
            testID="attack-add-kilotokens"
            accessibilityLabel={t("attack.run.addKiloTokens")}
            initialValue={addKiloTokens}
            onChangeText={setAddKiloTokens}
            keyboardType="number-pad"
          />
        </Field>
      </View>
      <Button
        size="sm"
        leftIcon={Play}
        onPress={onApply}
        disabled={busy}
        testID="attack-add-budget-apply"
      >
        {t("attack.run.addBudgetApply")}
      </Button>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

function parseAdded(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  return Number(trimmed);
}

function Meter({ label, fraction, testID }: { label: string; fraction: number; testID: string }) {
  return (
    <View style={styles.meter} testID={testID}>
      <Text style={styles.meterLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.meterTrack}>
        <View style={[styles.meterFill, { width: `${Math.round(fraction * 100)}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: theme.spacing[4],
    rowGap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  identity: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  target: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "500",
    flexShrink: 1,
  },
  statusChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
  },
  statusActive: { backgroundColor: theme.colors.palette.red[600] },
  statusEnded: { backgroundColor: theme.colors.surface2 },
  statusText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  meters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
    flexGrow: 1,
    flexShrink: 1,
  },
  meter: {
    gap: theme.spacing[1],
    minWidth: 120,
    flexGrow: 1,
    maxWidth: 220,
  },
  meterLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  meterTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  meterFill: {
    height: 4,
    backgroundColor: theme.colors.palette.red[500],
  },
  buttons: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  budgetPanel: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: theme.spacing[3],
    width: "100%",
  },
  budgetField: { width: 140 },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    width: "100%",
  },
}));
