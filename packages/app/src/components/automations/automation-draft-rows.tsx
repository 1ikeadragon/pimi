import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  useAutomationDraftActions,
  type AggregatedAutomationDraft,
} from "@/hooks/use-automation-drafts";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";

/** Descriptions still compiling, or that failed to, above the automation list. */
export function AutomationDraftRows({
  drafts,
}: {
  drafts: readonly AggregatedAutomationDraft[];
}): ReactElement {
  return (
    <View style={styles.list} testID="automation-drafts">
      <View style={settingsStyles.card}>
        {drafts.map((draft, index) => (
          <DraftRow key={`${draft.serverId}:${draft.id}`} draft={draft} isFirst={index === 0} />
        ))}
      </View>
    </View>
  );
}

function DraftRow({
  draft,
  isFirst,
}: {
  draft: AggregatedAutomationDraft;
  isFirst: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const actions = useAutomationDraftActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, []);
  const handleRetry = useCallback(
    () => void act(() => actions.retry(draft)),
    [act, actions, draft],
  );
  const handleDismiss = useCallback(
    () => void act(() => actions.dismiss(draft)),
    [act, actions, draft],
  );
  const failed = draft.state === "failed";
  return (
    <View
      style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder, styles.row]}
      testID={`automation-draft-${draft.id}`}
    >
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {draft.description}
        </Text>
        {failed ? (
          <Text style={styles.error} numberOfLines={2}>
            {error ?? draft.error}
          </Text>
        ) : null}
      </View>
      {failed ? (
        <View style={styles.actions}>
          <StatusBadge label={t("automationDrafts.failed")} variant="error" />
          <Button
            size="sm"
            variant="ghost"
            onPress={handleDismiss}
            disabled={busy}
            testID="automation-draft-dismiss"
          >
            {t("automationDrafts.dismiss")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onPress={handleRetry}
            loading={busy}
            testID="automation-draft-retry"
          >
            {t("automationDrafts.retry")}
          </Button>
        </View>
      ) : (
        <View style={styles.actions}>
          <LoadingSpinner size="small" color={styles.spinner.color} />
          <Text style={styles.drafting}>{t("automationDrafts.drafting")}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    marginBottom: theme.spacing[3],
  },
  row: {
    gap: theme.spacing[3],
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  drafting: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
