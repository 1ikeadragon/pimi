// Pimi. Apache-2.0.
import { useMemo } from "react";
import { getDesktopHost } from "@/desktop/host";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

export interface PimiWorkspaceReview {
  checkout: string;
  open: () => void;
}

export function usePimiWorkspaceReview(
  serverId: string,
  workspaceId: string,
): PimiWorkspaceReview | null {
  const show = getDesktopHost()?.showPimiWorkspace;
  const isLocal = useIsLocalDaemon(serverId);
  const checkout = useWorkspaceFields(
    serverId,
    workspaceId,
    (workspace) => workspace.workspaceDirectory,
  );
  return useMemo(
    () =>
      show && isLocal && checkout
        ? { checkout, open: () => show({ view: "review", path: checkout, serverId }) }
        : null,
    [checkout, isLocal, serverId, show],
  );
}
