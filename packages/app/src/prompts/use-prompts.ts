import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { SavedPrompt, SavedPromptDefinition } from "@pimi/protocol/prompt/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

// Same freshness window as the flow list: a prompt saved on another device shows up on the next
// menu open, and a write from this device invalidates the list at once.
const PROMPTS_STALE_MS = 15_000;

export function promptsQueryKey(serverId: string) {
  return ["prompts", serverId] as const;
}

// A prefix: with no project it covers every suggestion list of the host.
export function promptSuggestionsQueryKey(serverId: string, projectId?: string) {
  return projectId
    ? (["prompt-suggestions", serverId, projectId] as const)
    : (["prompt-suggestions", serverId] as const);
}

export function requirePromptClient(serverId: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) throw new Error("Host is not connected");
  return client;
}

/** The host's saved prompts, sorted by name. */
export function usePrompts(serverId: string, options: { enabled?: boolean } = {}) {
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: promptsQueryKey(serverId),
    enabled: Boolean(serverId) && connected && (options.enabled ?? true),
    dataShape: "list",
    staleTimeMs: PROMPTS_STALE_MS,
    queryFn: async (): Promise<SavedPrompt[]> =>
      (await requirePromptClient(serverId).promptList()).prompts,
  });
}

export interface PromptMutations {
  createPrompt: (definition: SavedPromptDefinition) => Promise<SavedPrompt>;
  updatePrompt: (input: {
    promptId: string;
    definition: SavedPromptDefinition;
  }) => Promise<SavedPrompt>;
  deletePrompt: (promptId: string) => Promise<void>;
}

/** Prompt writes for one host. Every write refreshes the prompt list. */
export function usePromptMutations(serverId: string): PromptMutations {
  const queryClient = useQueryClient();
  // Saving a prompt also removes it from the suggestions, so those refresh with the list.
  const refresh = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: promptsQueryKey(serverId) }),
        queryClient.invalidateQueries({ queryKey: promptSuggestionsQueryKey(serverId) }),
      ]),
    [queryClient, serverId],
  );
  const create = useMutation({
    mutationFn: async (definition: SavedPromptDefinition) =>
      (await requirePromptClient(serverId).promptCreate({ definition })).prompt,
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: async (input: { promptId: string; definition: SavedPromptDefinition }) =>
      (await requirePromptClient(serverId).promptUpdate(input)).prompt,
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (promptId: string) => {
      await requirePromptClient(serverId).promptDelete({ promptId });
    },
    onSuccess: refresh,
  });
  return useMemo(
    () => ({
      createPrompt: create.mutateAsync,
      updatePrompt: update.mutateAsync,
      deletePrompt: remove.mutateAsync,
    }),
    [create.mutateAsync, remove.mutateAsync, update.mutateAsync],
  );
}
