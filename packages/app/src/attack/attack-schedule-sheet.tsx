import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Play, Plus, Trash2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  AttackSchedule,
  AttackScheduleAuditEntry,
  AttackScheduleInput,
  AttackRoleId,
} from "@pimi/protocol/attack/types";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { toErrorMessage } from "@/utils/error-messages";
import { preferredModel, type AttackModelOption } from "./attack-run-form-model";
import { useModelOptions } from "./attack-launch-form";

// A saved run is unattended: the read-only roles that need nothing the owner would have to type.
const SCHEDULE_ROSTER: AttackRoleId[] = ["recon", "ui-qa", "api", "input"];
const REFRESH_MS = 10_000;

type TriggerKind = "schedule" | "pull_request" | "manual";

function getModelKey(option: AttackModelOption): string {
  return option.value;
}

function formatAt(iso: string | null, never: string): string {
  return iso ? new Date(iso).toLocaleString() : never;
}

function useSchedules(serverId: string, workspaceId: string) {
  const client = useHostRuntimeClient(serverId);
  const [schedules, setSchedules] = useState<AttackSchedule[]>([]);
  const [audit, setAudit] = useState<AttackScheduleAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const listed = await client.attackScheduleList({ workspaceId });
      setSchedules(listed.schedules);
      setAudit(listed.audit);
    } catch (caught) {
      setError(toErrorMessage(caught));
    }
  }, [client, workspaceId]);
  // Fetched on open and after each action, with a slow refresh so a fire shows without a reload.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  return { client, schedules, audit, error, setError, refresh };
}

export function AttackScheduleSheet({
  serverId,
  workspaceId,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client, schedules, audit, error, setError, refresh } = useSchedules(
    serverId,
    workspaceId,
  );
  const [adding, setAdding] = useState(false);
  const onAdd = useCallback(() => setAdding(true), []);
  const onSaved = useCallback(() => {
    setAdding(false);
    void refresh();
  }, [refresh]);
  const onCancelAdd = useCallback(() => setAdding(false), []);
  return (
    <ScrollView contentContainerStyle={styles.content} testID="attack-schedules">
      <View style={styles.header}>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={ArrowLeft}
          onPress={onClose}
          testID="attack-schedules-back"
        >
          {t("attack.schedules.back")}
        </Button>
        <Text style={styles.title}>{t("attack.schedules.title")}</Text>
        {adding ? null : (
          <Button
            size="sm"
            variant="outline"
            leftIcon={Plus}
            onPress={onAdd}
            testID="attack-schedule-add"
          >
            {t("attack.schedules.add")}
          </Button>
        )}
      </View>
      <Text style={styles.hint}>{t("attack.schedules.readOnlyNote")}</Text>
      {adding ? (
        <ScheduleForm
          serverId={serverId}
          workspaceId={workspaceId}
          onSaved={onSaved}
          onCancel={onCancelAdd}
        />
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {schedules.length === 0 && !adding ? (
        <Text style={styles.hint}>{t("attack.schedules.empty")}</Text>
      ) : null}
      {schedules.map((schedule) => (
        <ScheduleRow
          key={schedule.id}
          schedule={schedule}
          audit={audit.filter((entry) => entry.scheduleId === schedule.id)}
          client={client}
          onChanged={refresh}
          onError={setError}
        />
      ))}
    </ScrollView>
  );
}

function triggerSummary(
  t: (key: string, options?: Record<string, unknown>) => string,
  schedule: AttackSchedule,
): string {
  const trigger = schedule.trigger;
  if (trigger.kind === "schedule") {
    const minutes = trigger.cadence.type === "every" ? trigger.cadence.everyMs / 60_000 : 0;
    return trigger.cadence.type === "every"
      ? t("attack.schedules.summaryEvery", { minutes })
      : trigger.cadence.expression;
  }
  if (trigger.kind === "pull_request") {
    return t("attack.schedules.summaryPullRequest", { repo: trigger.repo });
  }
  return t("attack.schedules.triggerManual");
}

function ScheduleRow({
  schedule,
  audit,
  client,
  onChanged,
  onError,
}: {
  schedule: AttackSchedule;
  audit: AttackScheduleAuditEntry[];
  client: ReturnType<typeof useHostRuntimeClient>;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (action: "toggle" | "now" | "delete") => {
      if (!client) return;
      setBusy(true);
      onError(null);
      try {
        if (action === "toggle") {
          await client.attackScheduleSave({
            schedule: {
              id: schedule.id,
              workspaceId: schedule.workspaceId,
              name: schedule.name,
              enabled: !schedule.enabled,
              trigger: schedule.trigger,
              definition: schedule.definition,
              startCommand: schedule.startCommand,
              healthUrl: schedule.healthUrl,
            },
          });
        } else if (action === "now") {
          await client.attackScheduleRunNow({ scheduleId: schedule.id });
        } else {
          await client.attackScheduleDelete({ scheduleId: schedule.id });
        }
        await onChanged();
      } catch (caught) {
        onError(toErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [client, onChanged, onError, schedule],
  );
  const onToggle = useCallback(() => void run("toggle"), [run]);
  const onNow = useCallback(() => void run("now"), [run]);
  const onDelete = useCallback(() => void run("delete"), [run]);
  const never = t("attack.schedules.never");
  return (
    <View style={styles.row} testID={`attack-schedule-${schedule.id}`}>
      <View style={styles.rowTop}>
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {schedule.name}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {triggerSummary(t, schedule)} · {schedule.definition.target}
          </Text>
          <Text style={styles.rowMeta}>
            {schedule.trigger.kind === "schedule" && schedule.enabled
              ? `${t("attack.schedules.next", { at: formatAt(schedule.nextFireAt, never) })} · `
              : ""}
            {t("attack.schedules.last", { at: formatAt(schedule.lastFiredAt, never) })}
          </Text>
        </View>
        <Switch
          value={schedule.enabled}
          onValueChange={onToggle}
          disabled={busy}
          accessibilityLabel={t("attack.schedules.enabled")}
          testID="attack-schedule-enabled"
        />
        <Button
          size="sm"
          variant="outline"
          leftIcon={Play}
          onPress={onNow}
          disabled={busy}
          testID="attack-schedule-run-now"
        >
          {t("attack.schedules.runNow")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Trash2}
          onPress={onDelete}
          disabled={busy}
          accessibilityLabel={t("attack.schedules.delete")}
          testID="attack-schedule-delete"
        />
      </View>
      {audit.length > 0 ? (
        <View style={styles.auditList} testID="attack-schedule-audit">
          {audit
            .slice(-5)
            .toReversed()
            .map((entry) => (
              <Text key={`${entry.at}:${entry.outcome}`} style={styles.rowMeta} numberOfLines={2}>
                {new Date(entry.at).toLocaleString()} ·{" "}
                {t(`attack.schedules.outcome.${entry.outcome}`)}
                {entry.detail ? ` · ${entry.detail}` : ""}
              </Text>
            ))}
        </View>
      ) : null}
    </View>
  );
}

function buildTrigger(
  kind: TriggerKind,
  everyMs: number,
  repo: string,
): AttackScheduleInput["trigger"] {
  if (kind === "schedule") return { kind: "schedule", cadence: { type: "every", everyMs } };
  if (kind === "pull_request") {
    return { kind: "pull_request", repo: repo.trim(), events: ["opened", "synchronize"] };
  }
  return { kind: "manual" };
}

function ScheduleForm({
  serverId,
  workspaceId,
  onSaved,
  onCancel,
}: {
  serverId: string;
  workspaceId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const options = useModelOptions(serverId, cwd);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TriggerKind>("schedule");
  const [everyMinutes, setEveryMinutes] = useState("60");
  const [repo, setRepo] = useState("");
  const [target, setTarget] = useState("");
  const [healthUrl, setHealthUrl] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [minutes, setMinutes] = useState("10");
  const [pickedModel, setPickedModel] = useState<AttackModelOption | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = pickedModel ?? preferredModel(options);
  const triggerOptions = useMemo<SegmentedControlOption<TriggerKind>[]>(
    () => [
      {
        value: "schedule",
        label: t("attack.schedules.triggerSchedule"),
        testID: "attack-trigger-schedule",
      },
      {
        value: "pull_request",
        label: t("attack.schedules.triggerPullRequest"),
        testID: "attack-trigger-pr",
      },
      {
        value: "manual",
        label: t("attack.schedules.triggerManual"),
        testID: "attack-trigger-manual",
      },
    ],
    [t],
  );
  const modelDisplay = useMemo(() => (model ? { label: model.label } : null), [model]);
  const modelOptions = useMemo<SelectFieldOption<AttackModelOption>[]>(
    () => options.map((option) => ({ id: option.value, value: option, label: option.label })),
    [options],
  );
  const onSave = useCallback(async () => {
    if (!client || !model) return;
    const everyMs = Math.round(Number(everyMinutes) * 60_000);
    const budgetMs = Math.round(Number(minutes) * 60_000);
    if (!name.trim() || !target.trim() || !(budgetMs > 0)) {
      setError(t("attack.schedules.invalid"));
      return;
    }
    if (kind === "schedule" && !(everyMs >= 60_000)) {
      setError(t("attack.schedules.invalid"));
      return;
    }
    const trigger = buildTrigger(kind, everyMs, repo);
    setSaving(true);
    setError(null);
    try {
      await client.attackScheduleSave({
        schedule: {
          workspaceId,
          name: name.trim(),
          enabled: true,
          trigger,
          definition: {
            cwd,
            target: target.trim(),
            repoScope: false,
            scopeNotes: "",
            provider: model.value,
            roster: SCHEDULE_ROSTER,
            disposableTarget: false,
            limits: { maxRuntimeMs: budgetMs, maxTokens: 2_000_000 },
          },
          startCommand: startCommand.trim() || null,
          healthUrl: healthUrl.trim() || target.trim(),
        },
      });
      onSaved();
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }, [
    client,
    cwd,
    everyMinutes,
    healthUrl,
    kind,
    minutes,
    model,
    name,
    onSaved,
    repo,
    startCommand,
    t,
    target,
    workspaceId,
  ]);
  const onSavePress = useCallback(() => void onSave(), [onSave]);
  return (
    <View style={styles.form} testID="attack-schedule-form">
      <Field label={t("attack.schedules.name")}>
        <FormTextInput
          size="md"
          testID="attack-schedule-name"
          initialValue={name}
          onChangeText={setName}
        />
      </Field>
      <Field label={t("attack.schedules.trigger")}>
        <SegmentedControl options={triggerOptions} value={kind} onValueChange={setKind} size="sm" />
      </Field>
      {kind === "schedule" ? (
        <Field label={t("attack.schedules.everyMinutes")}>
          <FormTextInput
            size="md"
            testID="attack-schedule-every"
            initialValue={everyMinutes}
            onChangeText={setEveryMinutes}
            keyboardType="number-pad"
          />
        </Field>
      ) : null}
      {kind === "pull_request" ? (
        <Field label={t("attack.schedules.repo")}>
          <FormTextInput
            size="md"
            testID="attack-schedule-repo"
            initialValue={repo}
            onChangeText={setRepo}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      ) : null}
      <Field label={t("attack.schedules.target")}>
        <FormTextInput
          size="md"
          testID="attack-schedule-target"
          initialValue={target}
          onChangeText={setTarget}
          placeholder="http://localhost:3000"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("attack.schedules.healthUrl")}>
        <FormTextInput
          size="md"
          testID="attack-schedule-health"
          initialValue={healthUrl}
          onChangeText={setHealthUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("attack.schedules.startCommand")}>
        <FormTextInput
          size="md"
          testID="attack-schedule-start-command"
          initialValue={startCommand}
          onChangeText={setStartCommand}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("attack.schedules.minutes")}>
        <FormTextInput
          size="md"
          testID="attack-schedule-minutes"
          initialValue={minutes}
          onChangeText={setMinutes}
          keyboardType="number-pad"
        />
      </Field>
      <SelectField
        label={t("attack.form.model")}
        value={model}
        selectedDisplay={modelDisplay}
        options={modelOptions}
        onChange={setPickedModel}
        placeholder={t("attack.form.modelPlaceholder")}
        emptyText={t("attack.form.modelPlaceholder")}
        getValueKey={getModelKey}
        size="md"
        testID="attack-schedule-model"
      />
      <View style={styles.formButtons}>
        <Button variant="ghost" onPress={onCancel} testID="attack-schedule-cancel">
          {t("attack.schedules.cancel")}
        </Button>
        <Button
          variant="default"
          loading={saving}
          disabled={saving || !client || !model}
          onPress={onSavePress}
          testID="attack-schedule-save"
        >
          {t("attack.schedules.save")}
        </Button>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing[4], gap: theme.spacing[3] },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, fontWeight: "500" },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  form: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  formButtons: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  row: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  rowTop: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  rowMain: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  rowTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "500" },
  rowMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  auditList: { gap: theme.spacing[1] },
  errorText: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
}));
