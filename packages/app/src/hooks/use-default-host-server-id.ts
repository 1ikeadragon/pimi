import { useMemo } from "react";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHosts } from "@/runtime/host-runtime";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";

/**
 * The host an app-level surface acts on when no route names one: the host of the last workspace,
 * then the local daemon, then the first host. The command palette uses it so its host-bound rows
 * (settings pages, plugin items) stay available from Settings, Review and every other view.
 */
export function useDefaultHostServerId(): string | null {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const workspace = useLastWorkspaceSelection();
  const workspaceServerId = workspace?.serverId ?? null;
  return useMemo(
    () =>
      resolveActiveHostServerId({
        selectedServerId: workspaceServerId,
        localServerId,
        hosts,
        orderedHosts: orderHostsLocalFirst(hosts, localServerId),
      }),
    [hosts, localServerId, workspaceServerId],
  );
}
