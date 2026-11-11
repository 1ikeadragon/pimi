import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { openWorkspaceFileLocation } from "@/workspace/file-open/open-location";

const CODE_SEARCH_DEBOUNCE_MS = 300;
const CODE_SEARCH_LIMIT = 30;

type CodeSearchPayload = Awaited<ReturnType<DaemonClient["searchPimiCodebase"]>>;
export type WorkspaceCodeSearchResult = CodeSearchPayload["results"][number];

interface CodeSearchState {
  requestKey: string | null;
  payload: CodeSearchPayload | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: CodeSearchState = {
  requestKey: null,
  payload: null,
  loading: false,
  error: null,
};

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name !== "DaemonRpcError") return error.message;
  return error.message.replace(/ requestType=\S+(?: code=\S+)?$/, "");
}

function requestKeyForSearch(enabled: boolean, sourceKey: string | null, query: string) {
  return enabled && sourceKey && query ? `${sourceKey}\0${query}` : null;
}

async function runCodeSearch(input: {
  client: DaemonClient;
  workspaceId: string;
  query: string;
  requestKey: string;
  inFlight: { current: Promise<CodeSearchPayload> | null };
  cancelled(): boolean;
  setState(state: CodeSearchState): void;
}): Promise<void> {
  // Cold indexing can outlast typing. Keep one RPC in flight and drop superseded queries.
  const previous = input.inFlight.current;
  if (previous) await previous.catch(() => undefined);
  if (input.cancelled()) return;
  const request = input.client.searchPimiCodebase(
    input.workspaceId,
    input.query,
    CODE_SEARCH_LIMIT,
  );
  input.inFlight.current = request;
  try {
    const payload = await request;
    if (!input.cancelled())
      input.setState({ requestKey: input.requestKey, payload, loading: false, error: null });
  } catch (error) {
    if (!input.cancelled())
      input.setState({
        requestKey: input.requestKey,
        payload: null,
        loading: false,
        error: errorMessage(error),
      });
  } finally {
    if (input.inFlight.current === request) input.inFlight.current = null;
  }
}

export function useWorkspaceCodeSearch(input: { enabled: boolean; query: string }) {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );
  const [state, setState] = useState<CodeSearchState>(EMPTY_STATE);
  const inFlight = useRef<Promise<CodeSearchPayload> | null>(null);
  const sourceKey = useMemo(
    () => (serverId && workspaceId && cwd && client ? `${serverId}\0${workspaceId}\0${cwd}` : null),
    [client, cwd, serverId, workspaceId],
  );
  const query = input.query.trim();
  const requestKey = requestKeyForSearch(input.enabled, sourceKey, query);

  useEffect(() => {
    if (!requestKey || !client || !workspaceId) {
      setState(EMPTY_STATE);
      return;
    }
    let cancelled = false;
    setState({ requestKey, payload: null, loading: true, error: null });
    const timer = setTimeout(() => {
      void runCodeSearch({
        client,
        workspaceId,
        query,
        requestKey,
        inFlight,
        cancelled: () => cancelled,
        setState,
      });
    }, CODE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, query, requestKey, workspaceId]);

  const openResult = useCallback(
    (result: WorkspaceCodeSearchResult) => {
      if (!serverId || !workspaceId) return;
      clearCommandCenterFocusRestoreElement();
      openWorkspaceFileLocation({
        serverId,
        workspaceId,
        location: { path: result.path, lineStart: result.startLine, lineEnd: result.endLine },
      });
    },
    [serverId, workspaceId],
  );

  const current = state.requestKey === requestKey ? state : EMPTY_STATE;
  return {
    available: Boolean(sourceKey),
    results: current.payload?.results ?? [],
    mode: current.payload?.mode ?? null,
    filesIndexed: current.payload?.filesIndexed ?? 0,
    chunksIndexed: current.payload?.chunksIndexed ?? 0,
    partial: current.payload?.partial ?? false,
    loading: Boolean(requestKey) && (state.requestKey !== requestKey || current.loading),
    error: current.error,
    openResult,
  };
}
