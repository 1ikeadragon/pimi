import { useCallback, useEffect, useMemo, useRef, type ReactElement } from "react";
import { Text, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

// Long enough to read and reach the Review button, short enough not to pile up behind a second
// request. The request itself waits ten minutes on the daemon; the toast is only the nudge.
const APPROVAL_TOAST_MS = 15_000;

function useOnlineHostIds(): string[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  return useMemo(
    () => serverIds.filter((serverId) => statuses.get(serverId) === "online"),
    [serverIds, statuses],
  );
}

/**
 * Tells you when an agent starts waiting for vault approval, wherever you are in the app, so a
 * blocked agent is noticed. A host's first report after connecting only sets the baseline: a
 * request already pending then is not announced again on every reconnect.
 */
export function VaultApprovalWatcher(): null {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  const onlineIds = useOnlineHostIds();
  const onlineKey = onlineIds.join("|");
  const pendingByHost = useRef(new Map<string, number>());
  // Read when a request arrives, so moving between pages does not resubscribe the feed.
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const open = useCallback(
    (serverId: string) => router.push(buildSettingsHostSectionRoute(serverId, "vault")),
    [router],
  );

  useEffect(() => {
    const releases: Array<() => void> = [];
    for (const serverId of onlineKey ? onlineKey.split("|") : []) {
      const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
      if (!client) continue;
      const check = async () => {
        try {
          const { status } = await client.vaultGetStatus();
          const previous = pendingByHost.current.get(serverId);
          pendingByHost.current.set(serverId, status.pendingRequests);
          if (previous === undefined || status.pendingRequests <= previous) return;
          // The Vault page already lists the request.
          if (pathnameRef.current === buildSettingsHostSectionRoute(serverId, "vault")) return;
          toast.show(
            <ApprovalToast
              serverId={serverId}
              message={t("vaultApprovals.toast")}
              actionLabel={t("vaultApprovals.open")}
              onOpen={open}
            />,
            { variant: "warning", durationMs: APPROVAL_TOAST_MS },
          );
        } catch (error) {
          console.warn("[Vault] Failed to read approval status", error);
        }
      };
      const observation = client.observeEvents(["status.vault_changed"]);
      observation.subscribe({
        snapshot: () => void check(),
        update: (message) => {
          if (message.type === "status" && message.payload.status === "vault_changed") void check();
        },
      });
      releases.push(() => {
        pendingByHost.current.delete(serverId);
        void observation
          .release()
          .catch((error: unknown) =>
            console.warn("[Vault] Failed to release approval feed", error),
          );
      });
    }
    return () => {
      for (const release of releases) release();
    };
  }, [onlineKey, open, t, toast]);

  return null;
}

function ApprovalToast({
  serverId,
  message,
  actionLabel,
  onOpen,
}: {
  serverId: string;
  message: string;
  actionLabel: string;
  onOpen: (serverId: string) => void;
}): ReactElement {
  const press = useCallback(() => onOpen(serverId), [onOpen, serverId]);
  return (
    <View style={styles.row} testID="vault-approval-toast">
      <Text style={styles.message}>{message}</Text>
      <Button size="sm" variant="outline" onPress={press} testID="vault-approval-toast-action">
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
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));
