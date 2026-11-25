import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  NESTED_CHECKOUT_SCAN_DEPTH,
  type NestedChangesRepository,
  type SessionOutboundMessage,
} from "@pimi/protocol/messages";
import { getErrorMessage } from "@pimi/protocol/error-utils";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export type NestedChangesState =
  | { status: "idle" }
  | {
      status: "loading";
      /** Kept from the previous subscription while a new one opens, so a refresh does not blank the list. */
      repositories: readonly NestedChangesRepository[];
    }
  | {
      status: "ready";
      repositories: readonly NestedChangesRepository[];
      /** The daemon found more repositories than it lists. */
      truncated: boolean;
      /** Why the working-tree watch of expanded repositories could not be set up. */
      watchError: string | null;
    }
  | { status: "error"; error: string; repositories: readonly NestedChangesRepository[] };

type NestedChangesAction =
  | { type: "disable" }
  | { type: "connect" }
  | { type: "snapshot"; repositories: readonly NestedChangesRepository[]; truncated: boolean }
  | {
      type: "update";
      repositories: readonly NestedChangesRepository[];
      removed: readonly string[];
      truncated: boolean;
    }
  | { type: "failed"; error: string }
  | { type: "watch_result"; error: string | null };

const IDLE: NestedChangesState = { status: "idle" };

/** The daemon's own message: `Error.message` of an RPC failure also carries `requestType=...`. */
function failureMessage(error: unknown): string {
  if (error instanceof Error && "userMessage" in error && typeof error.userMessage === "string") {
    return error.userMessage;
  }
  return getErrorMessage(error);
}

function currentRepositories(state: NestedChangesState): readonly NestedChangesRepository[] {
  return state.status === "idle" ? [] : state.repositories;
}

function mergeRepositories(
  current: readonly NestedChangesRepository[],
  changed: readonly NestedChangesRepository[],
  removed: readonly string[],
): readonly NestedChangesRepository[] {
  const byRoot = new Map(current.map((repository) => [repository.root, repository]));
  for (const root of removed) byRoot.delete(root);
  for (const repository of changed) byRoot.set(repository.root, repository);
  return [...byRoot.values()];
}

function reduceNestedChanges(
  state: NestedChangesState,
  action: NestedChangesAction,
): NestedChangesState {
  switch (action.type) {
    case "disable":
      return IDLE;
    case "connect":
      return { status: "loading", repositories: currentRepositories(state) };
    case "snapshot":
      return {
        status: "ready",
        repositories: action.repositories,
        truncated: action.truncated,
        watchError: null,
      };
    case "update":
      if (state.status !== "ready") return state;
      return {
        ...state,
        repositories: mergeRepositories(state.repositories, action.repositories, action.removed),
        truncated: action.truncated,
      };
    case "failed":
      return { status: "error", error: action.error, repositories: currentRepositories(state) };
    case "watch_result":
      return state.status === "ready" ? { ...state, watchError: action.error } : state;
  }
}

export interface NestedChanges {
  state: NestedChangesState;
  /** Re-reads one repository, or the whole folder (and looks for new repositories) for null. */
  refresh(root: string | null): Promise<void>;
  /** Roots ordered least to most recently expanded; the daemon watches only the latest few. */
  setWatchedRoots(roots: readonly string[]): void;
}

function isNestedUpdate(
  message: SessionOutboundMessage,
): message is Extract<SessionOutboundMessage, { type: "checkout.nested.changes.update" }> {
  return message.type === "checkout.nested.changes.update";
}

/**
 * The changes of every Git repository inside `cwd`. Subscribes only while `enabled`, so a hidden
 * panel costs the daemon nothing (no polling, no watchers).
 */
export function useNestedChanges({
  serverId,
  cwd,
  enabled,
}: {
  serverId: string;
  cwd: string;
  enabled: boolean;
}): NestedChanges {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [state, dispatch] = useReducer(reduceNestedChanges, IDLE);
  const subscriptionIdRef = useRef<string | null>(null);
  const watchedRootsRef = useRef<readonly string[]>([]);

  const sendWatchedRoots = useCallback(async () => {
    const subscriptionId = subscriptionIdRef.current;
    if (!client || !subscriptionId) return;
    try {
      const result = await client.setNestedChangesWatchedRoots({
        subscriptionId,
        roots: [...watchedRootsRef.current],
      });
      dispatch({ type: "watch_result", error: result.error });
    } catch (error) {
      dispatch({ type: "watch_result", error: getErrorMessage(error) });
    }
  }, [client]);

  useEffect(() => {
    if (!enabled || !client || !isConnected || !cwd) {
      subscriptionIdRef.current = null;
      dispatch({ type: "disable" });
      return;
    }
    dispatch({ type: "connect" });
    const subscription = client.observeNestedChanges({
      cwd,
      depth: NESTED_CHECKOUT_SCAN_DEPTH,
    });
    const unsubscribe = subscription.subscribe({
      // Runs for the first bootstrap and again after every reconnect, which gets a new id.
      snapshot: (snapshot) => {
        subscriptionIdRef.current = snapshot.subscriptionId;
        dispatch({
          type: "snapshot",
          repositories: snapshot.repositories,
          truncated: snapshot.truncated,
        });
        if (watchedRootsRef.current.length > 0) void sendWatchedRoots();
      },
      update: (message) => {
        if (!isNestedUpdate(message)) return;
        dispatch({
          type: "update",
          repositories: message.payload.repositories,
          removed: message.payload.removed,
          truncated: message.payload.truncated,
        });
      },
      error: (error) => dispatch({ type: "failed", error: failureMessage(error) }),
    });
    return () => {
      unsubscribe();
      subscriptionIdRef.current = null;
      void subscription.release().catch((error: unknown) => {
        dispatch({ type: "failed", error: failureMessage(error) });
      });
    };
  }, [client, cwd, enabled, isConnected, sendWatchedRoots]);

  const refresh = useCallback(
    async (root: string | null) => {
      const subscriptionId = subscriptionIdRef.current;
      if (!client || !subscriptionId) throw new Error("The folder is not being observed");
      const result = await client.refreshNestedChanges({ subscriptionId, root });
      if (result.error) throw new Error(result.error);
    },
    [client],
  );

  const setWatchedRoots = useCallback(
    (roots: readonly string[]) => {
      watchedRootsRef.current = roots;
      void sendWatchedRoots();
    },
    [sendWatchedRoots],
  );

  return { state, refresh, setWatchedRoots };
}
