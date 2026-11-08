// Pimi addition to the Paseo fork. Apache-2.0.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PimiLinkedLabels } from "@pimi/protocol/pimi-task";
import { workspaceLabelKey } from "@pimi/protocol/workspace-labels";
import { getDesktopHost } from "@/desktop/host";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useWorkspaceLabelDefinitions } from "@/workspace-labels";
import { WorkspaceLabelChip } from "@/workspace-labels/chip";

const LinkedLabels = createContext<PimiLinkedLabels | null>(null);
const EMPTY: readonly string[] = [];

export function PimiLabelsProvider({ children }: { children: ReactNode }) {
  const localServerId = useLocalDaemonServerId() ?? "";
  const online = useHostRuntimeIsConnected(localServerId);
  const [snapshot, setSnapshot] = useState<PimiLinkedLabels | null>(null);
  useEffect(() => {
    const bridge = getDesktopHost()?.pimiLabels;
    if (!bridge || !online) return;
    let disposed = false;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (request: number) => {
      try {
        const next = await bridge.get();
        if (!disposed && revision === request) setSnapshot(next);
      } catch (error) {
        if (!disposed) console.warn("Pimi could not read linked labels:", error);
      }
    };
    const refresh = () => {
      const request = ++revision;
      clearTimeout(timer);
      timer = setTimeout(() => void load(request), 100);
    };
    const unsubscribe = bridge.subscribe(refresh);
    refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [online, localServerId]);
  return <LinkedLabels.Provider value={snapshot}>{children}</LinkedLabels.Provider>;
}

export function usePimiLinkedLabels() {
  return useContext(LinkedLabels);
}

export function usePimiLabelNames(
  serverId: string,
  workspaceId?: string | null,
  direct: readonly string[] = EMPTY,
  agentId?: string,
) {
  const projection = usePimiLinkedLabels();
  const linked = projection?.serverId === serverId ? projection : null;
  const work = (workspaceId && linked?.workspaces[workspaceId]) || EMPTY;
  const agent = (agentId && linked?.agents[agentId]) || EMPTY;
  return useMemo(() => {
    if (!work.length && !agent.length) return direct;
    return [
      ...new Map(
        [...direct, ...work, ...agent].map((name) => [workspaceLabelKey(name), name]),
      ).values(),
    ];
  }, [direct, work, agent]);
}

export function PimiAgentLabels({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId?: string | null;
  agentId: string;
}) {
  const direct = useWorkspaceFields(serverId, workspaceId ?? null, (workspace) => workspace.labels);
  const names = usePimiLabelNames(serverId, workspaceId, direct ?? EMPTY, agentId);
  const labels = useWorkspaceLabelDefinitions(serverId, names);
  if (!getDesktopHost()?.pimiLabels || !labels.length) return null;
  return (
    <View style={styles.chips} testID="pimi-agent-labels">
      {labels.map((label) => (
        <WorkspaceLabelChip key={workspaceLabelKey(label.name)} label={label} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chips: {
    alignSelf: "stretch",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
}));
