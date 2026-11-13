import { useSyncExternalStore } from "react";
import type { HostSummary } from "@pimi/protocol/hosts";
import { findAgentHostRow } from "@/hosts/agent-host-registration";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

/** The row the local daemon holds for this app host, or null when it has none. */
export function useAgentHostRegistration(serverId: string): HostSummary | null {
  const store = getHostRuntimeStore();
  const localServerId = useLocalDaemonServerId();
  const directory = useSyncExternalStore(
    (onChange) => store.subscribeHostDirectory(onChange),
    () => (localServerId ? store.getHostDirectory(localServerId) : null),
    () => null,
  );
  return directory ? findAgentHostRow(directory.hosts, serverId) : null;
}
