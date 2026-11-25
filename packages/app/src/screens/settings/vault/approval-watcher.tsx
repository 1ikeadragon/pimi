import { useCallback, useEffect, useMemo, useRef, type ReactElement } from "react";
import { Text, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useTranslation } from "@/i18n/use-translation";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { useVaultEnabled, useVaultSync, vaultErrorCode } from "./use-vault";
import { useSessionStore } from "@/stores/session-store";
import { buildHostAgentDetailRoute, buildSettingsHostSectionRoute } from "@/utils/host-routes";

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
 * blocked agent is noticed. Hosts with the vault off are not asked anything.
 */
export function VaultApprovalWatcher(): ReactElement {
  const onlineIds = useOnlineHostIds();
  return (
    <>
      {onlineIds.map((serverId) => (
        <HostApprovalWatcher key={serverId} serverId={serverId} />
      ))}
    </>
  );
}

function HostApprovalWatcher({ serverId }: { serverId: string }): ReactElement | null {
  const enabled = useVaultEnabled(serverId);
  return enabled ? <EnabledHostApprovalWatcher serverId={serverId} /> : null;
}

/**
 * Announces each request once, by id, including requests already waiting when the app connects.
 * A reconnect does not repeat a toast, and nothing is announced for the chat in front of you
 * (its card is above the composer) or while the Vault page lists the request.
 */
function EnabledHostApprovalWatcher({ serverId }: { serverId: string }): null {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  useVaultSync(serverId);
  const announced = useRef(new Set<string>());
  // Read when a request arrives, so moving between pages does not resubscribe the feed.
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const open = useCallback(
    (agentId: string | null) => {
      const agent = agentId
        ? useSessionStore.getState().sessions[serverId]?.agents?.get(agentId)
        : undefined;
      router.push(
        agentId
          ? buildHostAgentDetailRoute(serverId, agentId, agent?.workspaceId)
          : buildSettingsHostSectionRoute(serverId, "vault"),
      );
    },
    [router, serverId],
  );

  useEffect(() => {
    const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
    if (!client) return;
    const check = async () => {
      try {
        const { requests } = await client.vaultListRequests();
        const ids = new Set(requests.map((request) => request.id));
        for (const id of announced.current) {
          if (!ids.has(id)) announced.current.delete(id);
        }
        const session = useSessionStore.getState().sessions[serverId];
        const onVaultPage =
          pathnameRef.current === buildSettingsHostSectionRoute(serverId, "vault");
        for (const request of requests) {
          if (announced.current.has(request.id)) continue;
          announced.current.add(request.id);
          const chatFocused =
            request.agentId !== null && session?.focusedAgentId === request.agentId;
          if (onVaultPage || chatFocused) continue;
          toast.show(
            <ApprovalToast serverId={serverId} agentId={request.agentId} onOpen={open} />,
            { variant: "warning", durationMs: APPROVAL_TOAST_MS },
          );
        }
      } catch (error) {
        // Turning the vault off locks it, and that change event arrives before this host's config.
        if (vaultErrorCode(error) === "vault_disabled") return;
        console.warn("[Vault] Failed to read vault requests", error);
      }
    };
    const observation = client.observeEvents(["status.vault_changed"]);
    observation.subscribe({
      snapshot: () => void check(),
      update: (message) => {
        if (message.type === "status" && message.payload.status === "vault_changed") void check();
      },
    });
    return () => {
      void observation
        .release()
        .catch((error: unknown) => console.warn("[Vault] Failed to release approval feed", error));
    };
  }, [serverId, open, t, toast]);

  return null;
}

/** Reads the chat's title live, so a toast raised before the chat list loaded still names it. */
function ApprovalToast({
  serverId,
  agentId,
  onOpen,
}: {
  serverId: string;
  agentId: string | null;
  onOpen: (agentId: string | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const title = useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agents?.get(agentId)?.title : null,
  );
  const chat = title || agentId?.slice(0, 8) || t("vaultRequest.untitledChat");
  const press = useCallback(() => onOpen(agentId), [agentId, onOpen]);
  return (
    <View style={styles.row} testID="vault-approval-toast">
      <Text style={styles.message}>{t("vaultApprovals.toast", { chat })}</Text>
      <Button size="sm" variant="outline" onPress={press} testID="vault-approval-toast-action">
        {t("vaultRequest.review")}
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
