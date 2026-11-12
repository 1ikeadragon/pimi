import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSearchHit, ChatSearchResponse } from "@pimi/protocol/chat-search";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;
const PAGE_SIZE = 30;

export interface ChatContentHit extends ChatSearchHit {
  serverId: string;
}

interface SearchState {
  key: string | null;
  hits: ChatContentHit[];
  nextCursors: Record<string, string | null>;
  indexes: Record<string, ChatSearchResponse["index"]>;
  loading: boolean;
  error: string | null;
}

const IDLE: SearchState = {
  key: null,
  hits: [],
  nextCursors: {},
  indexes: {},
  loading: false,
  error: null,
};

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/ requestType=\S+(?: code=\S+)?$/, "");
}

async function searchHost(input: {
  serverId: string;
  query: string;
  limit: number;
  cursor?: string;
}): Promise<{ serverId: string; response: ChatSearchResponse }> {
  const client = getHostRuntimeStore().getClient(input.serverId);
  if (!client) throw new Error("Host is not connected");
  const response = await client.searchChats({
    query: input.query,
    limit: input.limit,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  return { serverId: input.serverId, response };
}

function mergeHosts(
  settled: PromiseSettledResult<{ serverId: string; response: ChatSearchResponse }>[],
  key: string,
): SearchState {
  const next: SearchState = { ...IDLE, key, hits: [], nextCursors: {}, indexes: {} };
  const errors: string[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      errors.push(describeError(result.reason));
      continue;
    }
    const { serverId, response } = result.value;
    if (response.error) errors.push(response.error);
    next.hits.push(...response.hits.map((hit) => ({ ...hit, serverId })));
    next.nextCursors[serverId] = response.nextCursor;
    next.indexes[serverId] = response.index;
  }
  next.error = next.hits.length === 0 && errors.length > 0 ? (errors[0] ?? null) : null;
  return next;
}

/**
 * Search of what was said in chats, on one or more hosts. Debounced; a newer query supersedes an
 * older one that is still in flight, and the older answer is dropped. Needs `minLength`
 * characters. Hits of each host come in the daemon's order, hosts one after another.
 */
export function useChatContentSearch(input: {
  enabled: boolean;
  query: string;
  serverIds: readonly string[];
  limit?: number;
  minLength?: number;
  /** Change it to search again for the same text. */
  refreshKey?: number;
}) {
  const query = input.query.trim();
  const limit = input.limit ?? PAGE_SIZE;
  const minLength = input.minLength ?? MIN_QUERY_LENGTH;
  const serverIds = input.serverIds;
  const hostsKey = serverIds.join("\0");
  const requestKey =
    input.enabled && query.length >= minLength && hostsKey
      ? `${hostsKey}\u0001${query}\u0001${input.refreshKey ?? 0}`
      : null;
  const [state, setState] = useState<SearchState>(IDLE);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    if (!requestKey) {
      setState(IDLE);
      return;
    }
    setState({ ...IDLE, key: requestKey, loading: true });
    const timer = setTimeout(async () => {
      const settled = await Promise.allSettled(
        serverIds.map((serverId) => searchHost({ serverId, query, limit })),
      );
      if (generation.current === mine) setState(mergeHosts(settled, requestKey));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [requestKey, query, limit, serverIds]);

  const loadMore = useCallback(async () => {
    const pending = Object.entries(state.nextCursors).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    );
    if (!requestKey || pending.length === 0) return;
    const mine = generation.current;
    setState((current) => ({ ...current, loading: true }));
    const settled = await Promise.allSettled(
      pending.map(([serverId, cursor]) => searchHost({ serverId, query, limit, cursor })),
    );
    if (generation.current !== mine) return;
    setState((current) => {
      const hits = [...current.hits];
      const nextCursors = { ...current.nextCursors };
      for (const result of settled) {
        if (result.status === "rejected") continue;
        const { serverId, response } = result.value;
        hits.push(...response.hits.map((hit) => ({ ...hit, serverId })));
        nextCursors[serverId] = response.nextCursor;
      }
      return { ...current, hits, nextCursors, loading: false };
    });
  }, [limit, query, requestKey, state.nextCursors]);

  const current = state.key === requestKey ? state : IDLE;
  const indexes = Object.values(current.indexes);
  return {
    hits: current.hits,
    loading: Boolean(requestKey) && (state.key !== requestKey || current.loading),
    error: current.error,
    hasMore: Object.values(current.nextCursors).some((cursor) => cursor !== null),
    loadMore,
    unindexedChats: indexes.reduce(
      (sum, index) => sum + Math.max(0, index.totalChats - index.indexedChats),
      0,
    ),
  };
}
