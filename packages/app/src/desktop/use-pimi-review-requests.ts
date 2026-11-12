// Pimi. Apache-2.0.
import { useEffect } from "react";
import type { PimiReviewRequest } from "@pimi/protocol/pimi-task";
import { getDesktopHost } from "@/desktop/host";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  checkoutReviewSource,
  openPimiReview,
  pullRequestUrlToSource,
} from "@/navigation/pimi-review";

/**
 * The Work window is a separate page, so its "Review changes" and "View PR" buttons ask the host
 * app to navigate. Both entry points read the local daemon: the Work board only lists local
 * checkouts, and its pull requests come from the local workspaces.
 */
export function usePimiReviewRequests(): void {
  const host = getDesktopHost();
  const localServerId = useLocalDaemonServerId();
  const open = useStableEvent((request: PimiReviewRequest) => {
    if (!localServerId) return;
    if (request.kind === "checkout") {
      openPimiReview(
        checkoutReviewSource({
          serverId: localServerId,
          cwd: request.path,
          baseRef: request.baseRef,
        }),
      );
      return;
    }
    const source = pullRequestUrlToSource(request.url, localServerId);
    if (source) openPimiReview(source);
  });
  useEffect(() => host?.onPimiReviewRequest?.(open), [host, open]);
}
