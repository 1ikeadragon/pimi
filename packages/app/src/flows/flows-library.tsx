import { useCallback, useMemo, useState } from "react";
import { router } from "expo-router";
import { Pencil, Plus, Trash2 } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Flow } from "@pimi/protocol/flow/types";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useTranslation } from "@/i18n/use-translation";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { buildFlowEditorRoute } from "@/utils/host-routes";
import { useFlowMutations, useFlows } from "./use-flows";

export function FlowsLibrary({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const flows = useFlows(serverId);
  const mutations = useFlowMutations(serverId);
  const [error, setError] = useState<string | null>(null);
  const refetch = flows.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);
  const openNew = useCallback(() => router.push(buildFlowEditorRoute(serverId, "new")), [serverId]);
  const newButton = useMemo(
    () => (
      <Button variant="outline" leftIcon={Plus} onPress={openNew} testID="flows-new">
        {t("flows.newFlow")}
      </Button>
    ),
    [openNew, t],
  );
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);
  const handleApprove = useCallback(
    (flow: Flow) => void run(() => mutations.approveFlow(flow.id)),
    [mutations, run],
  );
  const handleDelete = useCallback(
    async (flow: Flow) => {
      const confirmed = await confirmDialog({
        title: t("flows.deleteTitle"),
        message: t("flows.deleteMessage", { name: flow.name }),
        confirmLabel: t("flows.delete"),
        destructive: true,
      });
      if (confirmed) await run(() => mutations.deleteFlow(flow.id));
    },
    [mutations, run, t],
  );

  if (!flows.data) {
    return (
      <SettingsSection title={t("flows.title")} testID="flows-library">
        <SettingsCard>
          <SettingsRow label={flows.isError ? t("flows.loadFailed") : t("flows.loading")}>
            {flows.isError ? (
              <Button variant="outline" onPress={retry}>
                {t("flows.retry")}
              </Button>
            ) : null}
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }
  return (
    <View testID="flows-library">
      <SettingsSection title={t("flows.title")} info={t("flows.intro")} trailing={newButton}>
        <SettingsCard>
          {flows.data.length === 0 ? <SettingsRow label={t("flows.empty")} /> : null}
          {flows.data.map((flow) => (
            <FlowRow
              key={flow.id}
              serverId={serverId}
              flow={flow}
              onApprove={handleApprove}
              onDelete={handleDelete}
            />
          ))}
        </SettingsCard>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </SettingsSection>
    </View>
  );
}

function FlowRow({
  serverId,
  flow,
  onApprove,
  onDelete,
}: {
  serverId: string;
  flow: Flow;
  onApprove: (flow: Flow) => void;
  onDelete: (flow: Flow) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(
    () => router.push(buildFlowEditorRoute(serverId, flow.id)),
    [flow.id, serverId],
  );
  const approve = useCallback(() => onApprove(flow), [flow, onApprove]);
  const remove = useCallback(() => onDelete(flow), [flow, onDelete]);
  const command = flow.argumentHint ? `/${flow.name} ${flow.argumentHint}` : `/${flow.name}`;
  const stepCount = flow.flow.nodes.length;
  const hint = useMemo(
    () => (
      <View style={styles.hint}>
        <Text style={styles.description}>{flow.description}</Text>
        <Text style={styles.meta}>
          {command} · {t("flows.steps", { count: stepCount })}
        </Text>
      </View>
    ),
    [command, flow.description, stepCount, t],
  );
  return (
    <SettingsRow label={flow.name} hint={hint} testID={`flow-row-${flow.name}`}>
      <View style={styles.actions}>
        {flow.approved ? null : (
          <>
            <StatusBadge label={t("flows.waitingForApproval")} variant="warning" />
            <Button
              size="sm"
              variant="default"
              onPress={approve}
              testID={`flow-approve-${flow.name}`}
            >
              {t("flows.approve")}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="outline"
          leftIcon={Pencil}
          onPress={open}
          testID={`flow-open-${flow.name}`}
        >
          {t("flowEditor.open")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Trash2}
          onPress={remove}
          accessibilityLabel={t("flows.delete")}
          testID={`flow-delete-${flow.name}`}
        />
      </View>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  hint: { gap: 2 },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
