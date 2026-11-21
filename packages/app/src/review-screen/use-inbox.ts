// Pimi. PolyForm-Noncommercial-1.0.0.
// The Review home's data. One `forge.change_request.list_inbox` read per host, plus the
// change-request URL a user pastes into the search field.
import { useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { inboxStoreKey, useInboxStore } from "./inbox-store";
import { inboxQuery, markInboxRefresh, reviewKeys } from "./queries";
import type { ChangeRequestSource } from "./types";

import { REVIEW_FORGE_HOST, type ChangeRequestInbox, type InboxItem } from "./queries";

export { REVIEW_FORGE_HOST, type ChangeRequestInbox, type InboxItem } from "./queries";

export function useReviewInbox(serverId: string) {
  const connected = useHostRuntimeIsConnected(serverId);
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const query = useFetchQuery({ ...inboxQuery(serverId, client), enabled: connected });
  const refresh = useCallback(() => {
    markInboxRefresh(serverId);
    void queryClient.invalidateQueries({ queryKey: reviewKeys.inbox(serverId) });
  }, [queryClient, serverId]);
  // Rows come from the live query, else from the last inbox this host answered.
  const key = inboxStoreKey(serverId, REVIEW_FORGE_HOST);
  const stored = useInboxStore((state) => state.last[key]);
  const save = useInboxStore((state) => state.save);
  const live = query.data;
  useEffect(() => {
    if (live && !live.error) save(key, live);
  }, [key, live, save]);
  const data: Omit<ChangeRequestInbox, "requestId"> | undefined = live ?? stored;
  return { connected, query, data, refresh };
}

/** The pull request's row in the last inbox this host answered, if it was in it. */
export function useInboxSeed(ref: ChangeRequestSource | null): InboxItem | null {
  const key = inboxStoreKey(ref?.serverId ?? "", ref?.forgeHost ?? "");
  const last = useInboxStore((state) => state.last[key]);
  return useMemo(
    () => (ref && last ? (last.items.find((item) => sameChangeRequest(item, ref)) ?? null) : null),
    [last, ref],
  );
}

const PASTED_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d{1,15})(?:[/?#]\S*)?$/i;

/** A pasted pull request URL as a source, or null. Identity is validated again by the daemon. */
export function parsePastedChangeRequest(
  serverId: string,
  text: string,
): ChangeRequestSource | null {
  const match = PASTED_URL.exec(text.trim());
  if (!match) return null;
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return {
    kind: "change_request",
    serverId,
    forgeHost: match[1].toLowerCase(),
    owner: match[2],
    name: match[3],
    number,
  };
}

export function sameChangeRequest(
  a: { forgeHost: string; owner: string; name: string; number: number },
  b: { forgeHost: string; owner: string; name: string; number: number },
): boolean {
  return (
    a.number === b.number && a.owner === b.owner && a.name === b.name && a.forgeHost === b.forgeHost
  );
}
