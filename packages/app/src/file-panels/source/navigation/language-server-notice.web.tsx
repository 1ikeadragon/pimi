import { useCallback, useEffect } from "react";
import { Text, View } from "react-native";
import { router, type Href } from "expo-router";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-api-context";
import { useSessionStore } from "@/stores/session-store";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

// One notice per language per app launch, kept in memory on purpose: a restart is a fresh chance
// to set a server up, and nothing here is worth persisting.
const settledLanguages = new Set<string>();
const dismissers = new Map<string, () => void>();

function NoticeToast({
  message,
  action,
  serverId,
  languageId,
  noticeKey,
}: {
  message: string;
  action: string;
  serverId: string;
  languageId: string;
  noticeKey: string;
}) {
  const handleSetUp = useCallback(() => {
    dismissers.get(noticeKey)?.();
    router.push(
      `${buildSettingsHostSectionRoute(serverId, "terminals")}?language=${languageId}` as Href,
    );
  }, [languageId, noticeKey, serverId]);
  return (
    <View style={styles.row}>
      <Text style={styles.message}>{message}</Text>
      <Button size="sm" onPress={handleSetUp} testID="language-server-notice-action">
        {action}
      </Button>
    </View>
  );
}

/**
 * Tells the user, once per language and launch, that a code file's language has no working
 * language server, and offers the settings page that fixes it. Languages with no server mapping
 * (Markdown, JSON, ...) never trigger it.
 */
export function useLanguageServerNotice(input: {
  serverId: string;
  workspaceId: string;
  filename: string;
}): void {
  const { serverId, workspaceId, filename } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .queryCodeNavigation({
        workspaceId,
        path: filename,
        line: 1,
        column: 1,
        symbol: "x",
        kind: "capabilities",
      })
      .then((result) => {
        const language = result.renameSupport.language;
        if (cancelled || !language) return;
        const key = `${serverId}\0${language.id}`;
        if (settledLanguages.has(key)) return;
        if (language.serverFound) {
          settledLanguages.add(key);
          return;
        }
        settledLanguages.add(key);
        const message = t("settings.languageServers.notice.message", { language: language.label });
        const action = t("settings.languageServers.notice.action");
        const content = (
          <NoticeToast
            message={message}
            action={action}
            serverId={serverId}
            languageId={language.id}
            noticeKey={key}
          />
        );
        const dismiss = toast.show(content, {
          durationMs: 10_000,
          testID: "language-server-notice",
          onDismiss: () => dismissers.delete(key),
        });
        dismissers.set(key, dismiss);
        return;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, filename, serverId, t, toast, workspaceId]);
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  message: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
}));
