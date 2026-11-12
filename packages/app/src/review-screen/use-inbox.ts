// Pimi. Apache-2.0.
// Stream S2: the Review rail's data. One `forge.change_request.list_inbox` read per host, plus the
// change-request URL a user pastes into the search field.
import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ForgeChangeRequestListInboxResponse } from "@pimi/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ChangeRequestSource } from "./types";

export type ChangeRequestInbox = ForgeChangeRequestListInboxResponse["payload"];
export type InboxItem = ChangeRequestInbox["items"][number];

/** The rail reads GitHub through the host's `gh` login; other forges answer "unsupported". */
export const REVIEW_FORGE_HOST = "github.com";
const INBOX_STALE_MS = 30_000;
const INBOX_LIMIT = 50;

function inboxKey(serverId: string) {
  return ["review-screen", "inbox", serverId, REVIEW_FORGE_HOST] as const;
}

export function useReviewInbox(serverId: string) {
  const connected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const refreshNext = useRef(false);
  const query = useFetchQuery({
    queryKey: inboxKey(serverId),
    enabled: connected,
    dataShape: "list",
    staleTimeMs: INBOX_STALE_MS,
    queryFn: async (): Promise<ChangeRequestInbox> => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error("Host is not connected");
      const refresh = refreshNext.current;
      refreshNext.current = false;
      return client.forgeChangeRequestListInbox({
        forgeHost: REVIEW_FORGE_HOST,
        scopes: ["review_requested", "authored"],
        limit: INBOX_LIMIT,
        ...(refresh ? { refresh: true } : {}),
      });
    },
  });
  const refresh = useCallback(() => {
    refreshNext.current = true;
    void queryClient.invalidateQueries({ queryKey: inboxKey(serverId) });
  }, [queryClient, serverId]);
  return { connected, query, refresh };
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
