// Pimi. PolyForm-Noncommercial-1.0.0.
// Gives every writer under a pull request page (comment box, thread cards, the thread panel, the
// review sheet) the same ref, forge capabilities and connection state.
import { useMemo, type ReactNode } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { filesQuery } from "../queries";
import type { ChangeRequestSource } from "../types";
import type { ReviewTimeline } from "../use-review-timeline";
import {
  ReviewWriteContext,
  useReviewWrites,
  type ReviewWriteContextValue,
} from "./use-review-writes";

export function ReviewWriteProvider({
  source,
  timeline,
  children,
}: {
  source: ChangeRequestSource;
  timeline: ReviewTimeline;
  children: ReactNode;
}) {
  const client = useHostRuntimeClient(source.serverId);
  const connected = useHostRuntimeIsConnected(source.serverId);
  const writes = useReviewWrites(source);
  // The files read is shared with the Files tab; the commit a review is of is the diff's.
  const files = useFetchQuery({
    ...filesQuery(source, client),
    enabled: Boolean(client) && connected,
  });
  const { overview, status } = timeline;
  const value = useMemo<ReviewWriteContextValue>(
    () => ({
      ref: source,
      writes,
      actions: overview?.actions ?? null,
      state: overview?.state ?? null,
      connected,
      viewerIsAuthor: status?.viewerIsAuthor ?? false,
      headSha: files.data?.headSha ?? null,
    }),
    [connected, files.data?.headSha, overview?.actions, overview?.state, source, status, writes],
  );
  return <ReviewWriteContext.Provider value={value}>{children}</ReviewWriteContext.Provider>;
}
