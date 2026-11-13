import { useQuery } from "@tanstack/react-query";
import { getDesktopDaemonStatus, shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";

const DESKTOP_DAEMON_SERVER_ID_QUERY_KEY = ["desktop-daemon-server-id"] as const;
// A setup with no local daemon never resolves an id, so the poll backs off from 1 s to 30 s.
const SERVER_ID_POLL_BASE_MS = 1000;
const SERVER_ID_POLL_MAX_MS = 30_000;

interface DesktopDaemonServerIdResult {
  serverId: string | null;
}

async function loadDesktopDaemonServerId(): Promise<DesktopDaemonServerIdResult> {
  const status = await getDesktopDaemonStatus();
  const serverId = status.serverId.trim();
  return {
    serverId: serverId.length > 0 ? serverId : null,
  };
}

function useLocalDaemonServerIdQuery() {
  const isDesktopApp = shouldUseDesktopDaemon();

  return useQuery({
    queryKey: DESKTOP_DAEMON_SERVER_ID_QUERY_KEY,
    queryFn: loadDesktopDaemonServerId,
    enabled: isDesktopApp,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: (activeQuery) =>
      activeQuery.state.data?.serverId
        ? false
        : Math.min(
            SERVER_ID_POLL_MAX_MS,
            SERVER_ID_POLL_BASE_MS * 2 ** activeQuery.state.dataUpdateCount,
          ),
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useLocalDaemonServerId(): string | null {
  const isDesktopApp = shouldUseDesktopDaemon();
  const query = useLocalDaemonServerIdQuery();

  if (!isDesktopApp) {
    return null;
  }

  return query.data?.serverId ?? null;
}

export type LocalDaemonServerIdState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "resolved"; serverId: string | null };

export function useLocalDaemonServerIdState(): LocalDaemonServerIdState {
  const isDesktopApp = shouldUseDesktopDaemon();
  const query = useLocalDaemonServerIdQuery();

  if (!isDesktopApp) {
    return { status: "resolved", serverId: null };
  }
  if (query.isError) {
    return { status: "error" };
  }
  if (query.isSuccess) {
    return { status: "resolved", serverId: query.data.serverId };
  }
  return { status: "loading" };
}

export function useIsLocalDaemon(serverId: string): boolean {
  const normalizedServerId = serverId.trim();
  const localServerId = useLocalDaemonServerId();

  if (localServerId === null || normalizedServerId.length === 0) {
    return false;
  }

  return localServerId === normalizedServerId;
}
