import { NESTED_CHECKOUT_SCAN_DEPTH } from "@pimi/protocol/messages";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { CHECKOUT_STATUS_STALE_TIME } from "@/git/use-status-query";
import { nestedCheckoutsQueryKey } from "@/git/query-keys";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useWorkspaceDirectory, useWorkspaceFields } from "@/stores/session-store-hooks";

/** Repositories inside a folder come and go slowly; the Review inbox reads the same list on this cadence. */
const NESTED_LIST_STALE_MS = 30_000;

interface FileRepository {
  root: string;
  /** The file's path from `root`. */
  path: string;
}

/** The deepest repository root containing `absolute`, with the path from it. */
function findRepository(absolute: string, roots: readonly string[]): FileRepository | null {
  let best: string | null = null;
  for (const root of roots) {
    const inside = absolute.startsWith(`${root}/`);
    if (inside && (best === null || root.length > best.length)) best = root;
  }
  return best === null ? null : { root: best, path: absolute.slice(best.length + 1) };
}

function useFileRepository(input: {
  serverId: string;
  workspaceId: string;
  path: string;
}): FileRepository | null {
  const { serverId, workspaceId, path } = input;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const isPlainFolder = useWorkspaceFields(
    serverId,
    workspaceId,
    (workspace) => workspace.workspaceKind === "directory",
  );
  // A plain folder has no repository of its own; its files belong to the repositories inside it.
  const nested = useFetchQuery({
    dataShape: "list",
    queryKey: nestedCheckoutsQueryKey(serverId, cwd ?? ""),
    queryFn: async () => {
      if (!client || !cwd) return [];
      const listing = await client.listNestedCheckouts(cwd, NESTED_CHECKOUT_SCAN_DEPTH);
      if (listing.error) throw new Error(listing.error);
      return listing.checkouts;
    },
    enabled: Boolean(client && isConnected && cwd && isPlainFolder),
    staleTimeMs: NESTED_LIST_STALE_MS,
  });
  if (!cwd) return null;
  if (!isPlainFolder) return { root: cwd, path };
  return findRepository(`${cwd.replace(/\/$/, "")}/${path}`, nested.data ?? []);
}

/**
 * The file's text at HEAD, for the editor to mark changed lines against. An empty string for a file
 * HEAD does not contain, so every line shows as added. Null when there is nothing to compare:
 * outside a repository, a binary or oversized base, or before the first read.
 */
export function useHeadBase(input: {
  serverId: string;
  workspaceId: string;
  path: string;
}): string | null {
  const { serverId } = input;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const active = useRetainedPanelActive();
  const repository = useFileRepository(input);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["checkoutFileBase", serverId, repository?.root ?? "", repository?.path ?? ""],
    queryFn: async () => {
      if (!client || !repository) return null;
      const base = await client.getCheckoutFileBase({
        cwd: repository.root,
        path: repository.path,
      });
      if (base.error) throw new Error(base.error);
      if (base.status === "text") return base.content;
      return base.status === "missing" ? "" : null;
    },
    enabled: Boolean(client && isConnected && repository && active),
    // A commit made elsewhere moves HEAD without touching this file, so the base is re-read on the
    // same cadence as the Git status.
    refetchInterval: active ? CHECKOUT_STATUS_STALE_TIME : false,
    staleTimeMs: CHECKOUT_STATUS_STALE_TIME,
  });
  return query.data ?? null;
}
