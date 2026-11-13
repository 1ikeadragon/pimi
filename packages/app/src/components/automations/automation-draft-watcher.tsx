import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { getIsElectron } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import {
  announceableDraftKeys,
  useAutomationDraftActions,
  useAutomationDraftSync,
  useAutomationDrafts,
  type AggregatedAutomationDraft,
} from "@/hooks/use-automation-drafts";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { toErrorMessage } from "@/utils/error-messages";
import { buildAutomationEditorRoute } from "@/utils/host-routes";
import { sendOsNotification } from "@/utils/os-notifications";

const SUMMARY_LENGTH = 80;
const READY_TOAST_MS = 10_000;

function summary(description: string): string {
  const line = description.split("\n")[0]?.trim() ?? "";
  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1)}…` : line;
}

/**
 * Announces drafts that finish while the app is open: a toast everywhere, and the OS notification
 * on desktop when the window is in the background. Only a draft this client saw drafting is
 * announced, so a reload does not repeat old news.
 */
export function AutomationDraftWatcher(): null {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  useAutomationDraftSync();
  const drafts = useAutomationDrafts();
  const actions = useAutomationDraftActions();

  // Toast buttons reach their draft through these, so the toast content takes stable props.
  const shown = useRef(
    new Map<string, { draft: AggregatedAutomationDraft; dismiss: () => void }>(),
  );
  const handleAction = useCallback(
    (key: string) => {
      const entry = shown.current.get(key);
      if (!entry) return;
      shown.current.delete(key);
      entry.dismiss();
      const { draft } = entry;
      if (draft.state === "ready" && draft.automationId) {
        router.push(buildAutomationEditorRoute(draft.serverId, draft.automationId));
        return;
      }
      actions.retry(draft).catch((error: unknown) => toast.error(toErrorMessage(error)));
    },
    [actions, router, toast],
  );

  useEffect(() => {
    for (const draft of drafts) {
      const key = `${draft.serverId}:${draft.id}`;
      if (draft.state === "drafting") {
        announceableDraftKeys.add(key);
        continue;
      }
      if (!announceableDraftKeys.delete(key)) continue;
      actions.refresh();
      const ready = draft.state === "ready";
      const dismiss = toast.show(
        <DraftToast
          draftKey={key}
          message={
            ready
              ? t("automationDrafts.readyToast")
              : t("automationDrafts.failedToast", { reason: draft.error ?? "" })
          }
          detail={summary(draft.description)}
          actionLabel={ready ? t("automationDrafts.open") : t("automationDrafts.retry")}
          onAction={handleAction}
          testID={ready ? "automation-draft-ready-toast" : "automation-draft-failed-toast"}
        />,
        {
          variant: ready ? "success" : "error",
          durationMs: ready ? READY_TOAST_MS : null,
          onDismiss: () => shown.current.delete(key),
        },
      );
      shown.current.set(key, { draft, dismiss });
      if (ready && draft.automationId && getIsElectron() && !getIsAppActivelyVisible()) {
        void sendOsNotification({
          title: t("automationDrafts.readyToast"),
          body: summary(draft.description),
          data: { serverId: draft.serverId, automationId: draft.automationId },
        });
      }
    }
  }, [actions, drafts, handleAction, t, toast]);

  return null;
}

function DraftToast({
  draftKey,
  message,
  detail,
  actionLabel,
  onAction,
  testID,
}: {
  draftKey: string;
  message: string;
  detail: string;
  actionLabel: string;
  onAction: (draftKey: string) => void;
  testID: string;
}): ReactElement {
  const handlePress = useCallback(() => onAction(draftKey), [draftKey, onAction]);
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.text}>
        <Text style={styles.message}>{message}</Text>
        {detail ? (
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Button size="sm" variant="outline" onPress={handlePress} testID={`${testID}-action`}>
        {actionLabel}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  text: {
    flexShrink: 1,
    gap: theme.spacing[1],
  },
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
