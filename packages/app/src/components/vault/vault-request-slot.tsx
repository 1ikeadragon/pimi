import { useCallback } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/use-translation";
import { useVaultEnabled, useVaultRequests } from "@/screens/settings/vault/use-vault";
import { useSessionStore } from "@/stores/session-store";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { VaultRequestCard } from "./vault-request-card";

const NO_AGENT_IDS: string[] = [];

/**
 * The vault request of the chat above its composer, and a one-line row for each subagent that
 * waits on the vault. Mounts nothing and fetches nothing while the host's vault is off.
 */
export function VaultRequestSlot({ serverId, agentId }: { serverId: string; agentId: string }) {
  const enabled = useVaultEnabled(serverId);
  if (enabled !== true) return null;
  return <EnabledVaultRequestSlot serverId={serverId} agentId={agentId} />;
}

function EnabledVaultRequestSlot({ serverId, agentId }: { serverId: string; agentId: string }) {
  const requests = useVaultRequests(serverId, true).data;
  const own = requests?.find((request) => request.agentId === agentId);
  // Only the few agents that wait on the vault are examined, so this stays cheap on every store update.
  const childAgentIds = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!requests || requests.length === 0) return NO_AGENT_IDS;
      const agents = state.sessions[serverId]?.agents;
      const ids: string[] = [];
      for (const request of requests) {
        if (request.agentId && agents?.get(request.agentId)?.parentAgentId === agentId) {
          ids.push(request.agentId);
        }
      }
      return ids.length > 0 ? ids : NO_AGENT_IDS;
    },
    shallow,
  );
  if (!own && childAgentIds.length === 0) return null;
  return (
    <View style={styles.slot}>
      {childAgentIds.map((childId) => (
        <SubagentRequestRow key={childId} serverId={serverId} agentId={childId} />
      ))}
      {own ? <VaultRequestCard serverId={serverId} request={own} /> : null}
    </View>
  );
}

function SubagentRequestRow({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const agent = useSessionStore((state) => state.sessions[serverId]?.agents?.get(agentId));
  const title = agent?.title ?? agentId.slice(0, 8);
  const workspaceId = agent?.workspaceId;
  const review = useCallback(
    () => router.push(buildHostAgentDetailRoute(serverId, agentId, workspaceId)),
    [agentId, router, serverId, workspaceId],
  );
  return (
    <View style={styles.row} testID={`vault-subagent-row-${agentId}`}>
      <Text style={styles.rowText} numberOfLines={1}>
        {t("vaultRequest.subagent", { title })}
      </Text>
      <Button size="sm" variant="ghost" onPress={review}>
        {t("vaultRequest.review")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  rowText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
