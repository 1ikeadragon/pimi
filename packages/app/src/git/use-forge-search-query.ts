import { useTranslation } from "@/i18n/use-translation";
import {
  ForgeSearchItemSchema,
  type ForgeAuthState,
  type ForgeSearchItem,
  ForgeSearchKind,
  type ForgeSearchResponse,
} from "@pimi/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { useFetchQuery } from "@/data/query";
import { parseForgeAuthState } from "@/git/forge";

export const FORGE_SEARCH_STALE_TIME = 30_000;

export interface ForgeSearchPayload {
  items: ForgeSearchItem[];
  authState: ForgeAuthState;
  error: string | null;
  requestId: string;
}

interface ForgeSearchOptions {
  cwd: string;
  query: string;
  limit?: number;
  kinds?: ForgeSearchKind[];
}

export interface ForgeSearchClient {
  searchForge: (
    options: ForgeSearchOptions,
    requestId?: string,
  ) => Promise<ForgeSearchResponse["payload"]>;
}

interface ForgeSearchQueryInput {
  client: ForgeSearchClient | null;
  serverId: string;
  cwd: string;
  query: string;
  kinds?: ForgeSearchKind[];
  enabled: boolean;
  hostDisconnectedMessage?: string;
}

export function forgeSearchQueryKey(
  serverId: string,
  cwd: string,
  query: string,
  kinds?: ForgeSearchKind[],
) {
  const trimmedQuery = query.trim();
  if (!kinds) {
    return ["forge-search", serverId, cwd, trimmedQuery] as const;
  }
  return ["forge-search", serverId, cwd, trimmedQuery, [...kinds].sort().join(",")] as const;
}

export function buildForgeSearchQueryOptions(input: ForgeSearchQueryInput) {
  const query = input.query.trim();

  return {
    queryKey: forgeSearchQueryKey(input.serverId, input.cwd, query, input.kinds),
    queryFn: async (): Promise<ForgeSearchPayload> => {
      if (!input.client) {
        throw new Error(
          input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"),
        );
      }
      const request = input.kinds
        ? { cwd: input.cwd, query, limit: 20, kinds: input.kinds }
        : { cwd: input.cwd, query, limit: 20 };
      return normalizeForgeSearchPayload(await input.client.searchForge(request));
    },
    enabled: input.enabled && Boolean(input.client),
    dataShape: "list" as const,
    staleTimeMs: FORGE_SEARCH_STALE_TIME,
  };
}

function normalizeForgeSearchPayload(payload: ForgeSearchResponse["payload"]): ForgeSearchPayload {
  return {
    items: payload.items.flatMap((item) => {
      const result = ForgeSearchItemSchema.safeParse(item);
      return result.success ? [result.data] : [];
    }),
    authState: parseForgeAuthState(payload.authState) ?? "unauthenticated",
    error: payload.error,
    requestId: payload.requestId,
  };
}

export function useForgeSearchQuery(input: ForgeSearchQueryInput) {
  const { t } = useTranslation();
  return useFetchQuery(
    buildForgeSearchQueryOptions({
      ...input,
      hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
    }),
  );
}
