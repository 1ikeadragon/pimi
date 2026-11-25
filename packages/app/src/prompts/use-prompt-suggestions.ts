import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PromptSuggestion, PromptSuggestionPosition } from "@pimi/protocol/prompt/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { promptSuggestionsQueryKey, requirePromptClient } from "./use-prompts";

// Each read scans the project's chats on the host, and the answer only changes when a chat gets a
// new message, so a minute is fresh enough that reopening the screen does not rescan.
const SUGGESTIONS_STALE_MS = 60_000;

/** The phrases a project's chats repeat. A daemon-side read failure is thrown, not hidden. */
export function usePromptSuggestions(input: {
  serverId: string;
  projectId: string | null;
  position: PromptSuggestionPosition;
  enabled?: boolean;
  limit?: number;
}) {
  const { serverId, projectId, position, limit } = input;
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: [...promptSuggestionsQueryKey(serverId, projectId ?? "none"), position, limit],
    enabled: Boolean(serverId && projectId) && connected && (input.enabled ?? true),
    dataShape: "list",
    staleTimeMs: SUGGESTIONS_STALE_MS,
    retry: false,
    queryFn: async (): Promise<PromptSuggestion[]> => {
      if (!projectId) throw new Error("Choose a project");
      const payload = await requirePromptClient(serverId).promptSuggestionsList({
        projectId,
        position,
        limit,
      });
      if (payload.error) throw new Error(payload.error);
      return payload.suggestions;
    },
  });
}

/** Dismisses a suggestion for one project and refreshes that project's lists. */
export function useDismissPromptSuggestion(serverId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (input: { projectId: string; key: string }) => {
      const payload = await requirePromptClient(serverId).promptSuggestionsDismiss(input);
      if (payload.error) throw new Error(payload.error);
    },
    onSuccess: (_result, input) =>
      queryClient.invalidateQueries({
        queryKey: promptSuggestionsQueryKey(serverId, input.projectId),
      }),
  });
  return mutation.mutateAsync;
}
