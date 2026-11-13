import { useCallback } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useTranslation } from "@/i18n/use-translation";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type {
  Automation,
  AutomationDefinition,
  AutomationOrigin,
  AutomationRun,
} from "@pimi/protocol/automation/types";
import type {
  AggregatedAutomation,
  FetchAggregatedAutomationsState,
} from "@/automations/aggregated-automations";
import { automationsQueryBaseKey } from "@/automations/aggregated-automations";
import { useSessionStore } from "@/stores/session-store";

export interface CreateAutomationInput {
  definition: AutomationDefinition;
  /** `compiled` when the owner saves a draft compiled from prose; it then waits for approval. */
  origin?: AutomationOrigin;
}

export interface RetryAutomationRunInput {
  automationId: string;
  runId: string;
}

export interface UpdateAutomationInput {
  automationId: string;
  definition: AutomationDefinition;
}

export interface UseAutomationMutationsResult {
  createAutomation: (input: CreateAutomationInput) => Promise<Automation>;
  updateAutomation: (input: UpdateAutomationInput) => Promise<void>;
  pauseAutomation: (id: string) => Promise<void>;
  resumeAutomation: (id: string) => Promise<void>;
  approveAutomation: (id: string) => Promise<void>;
  deleteAutomation: (id: string) => Promise<void>;
  runAutomationNow: (id: string) => Promise<AutomationRun>;
  retryAutomationRun: (input: RetryAutomationRunInput) => Promise<AutomationRun>;
  isRetrying: boolean;
  isCreating: boolean;
  isUpdating: boolean;
  isPausing: boolean;
  isResuming: boolean;
  isApproving: boolean;
  isDeleting: boolean;
  isRunningNow: boolean;
}

interface AutomationListSnapshot {
  previous: Array<[QueryKey, FetchAggregatedAutomationsState | undefined]>;
}

export function updateAggregatedAutomationsData(
  current: FetchAggregatedAutomationsState | undefined,
  updateAutomations: (automations: AggregatedAutomation[]) => AggregatedAutomation[],
): FetchAggregatedAutomationsState | undefined {
  if (!current || current.status !== "loaded") {
    return current;
  }
  return { ...current, data: updateAutomations(current.data) };
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

function snapshotAutomations(queryClient: QueryClient): AutomationListSnapshot {
  return {
    previous: queryClient.getQueriesData<FetchAggregatedAutomationsState>({
      queryKey: automationsQueryBaseKey,
    }),
  };
}

function restoreAutomations(queryClient: QueryClient, snapshot: AutomationListSnapshot): void {
  for (const [queryKey, previous] of snapshot.previous) {
    queryClient.setQueryData(queryKey, previous);
  }
}

function updateAutomationsData(
  queryClient: QueryClient,
  updateAutomations: (automations: AggregatedAutomation[]) => AggregatedAutomation[],
): void {
  queryClient.setQueriesData<FetchAggregatedAutomationsState>(
    { queryKey: automationsQueryBaseKey },
    (current) => updateAggregatedAutomationsData(current, updateAutomations),
  );
}

function optimisticallySetStatus(
  queryClient: QueryClient,
  serverId: string,
  id: string,
  status: Automation["status"],
): void {
  updateAutomationsData(queryClient, (automations) =>
    automations.map((automation) =>
      automation.serverId === serverId && automation.id === id
        ? { ...automation, status, pausedReason: status === "paused" ? "user" : null }
        : automation,
    ),
  );
}

function optimisticallyRemove(queryClient: QueryClient, serverId: string, id: string): void {
  updateAutomationsData(queryClient, (automations) =>
    automations.filter((automation) => !(automation.serverId === serverId && automation.id === id)),
  );
}

export function useAutomationMutations({
  serverId,
}: {
  serverId: string;
}): UseAutomationMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: automationsQueryBaseKey });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateAutomationInput): Promise<Automation> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      return (await client.automationCreate(input)).automation;
    },
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateAutomationInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      await client.automationUpdate(input);
    },
    onSettled: invalidate,
  });

  const pauseMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      await client.automationPause({ automationId: id });
    },
    onMutate: async (id): Promise<AutomationListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: automationsQueryBaseKey });
      const snapshot = snapshotAutomations(queryClient);
      optimisticallySetStatus(queryClient, serverId, id, "paused");
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreAutomations(queryClient, context);
      }
    },
    onSettled: invalidate,
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      await client.automationEnable({ automationId: id });
    },
    onMutate: async (id): Promise<AutomationListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: automationsQueryBaseKey });
      const snapshot = snapshotAutomations(queryClient);
      optimisticallySetStatus(queryClient, serverId, id, "active");
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreAutomations(queryClient, context);
      }
    },
    onSettled: invalidate,
  });

  const approveMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      await client.automationApprove({ automationId: id });
    },
    onMutate: async (id): Promise<AutomationListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: automationsQueryBaseKey });
      const snapshot = snapshotAutomations(queryClient);
      optimisticallySetStatus(queryClient, serverId, id, "active");
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreAutomations(queryClient, context);
      }
    },
    onSettled: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      await client.automationDelete({ automationId: id });
    },
    onMutate: async (id): Promise<AutomationListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: automationsQueryBaseKey });
      const snapshot = snapshotAutomations(queryClient);
      optimisticallyRemove(queryClient, serverId, id);
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreAutomations(queryClient, context);
      }
    },
    onSettled: invalidate,
  });

  const runNowMutation = useMutation({
    mutationFn: async (id: string): Promise<AutomationRun> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      return (await client.automationRunStart({ automationId: id })).run;
    },
    onSettled: invalidate,
  });

  const retryMutation = useMutation({
    mutationFn: async (input: RetryAutomationRunInput): Promise<AutomationRun> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      return (await client.automationRunRetry(input)).run;
    },
    onSettled: invalidate,
  });

  const retryAutomationRun = useCallback(
    (input: RetryAutomationRunInput) => retryMutation.mutateAsync(input),
    [retryMutation],
  );

  const createAutomation = useCallback(
    (input: CreateAutomationInput): Promise<Automation> => createMutation.mutateAsync(input),
    [createMutation],
  );

  const updateAutomation = useCallback(
    async (input: UpdateAutomationInput): Promise<void> => {
      await updateMutation.mutateAsync(input);
    },
    [updateMutation],
  );

  const pauseAutomation = useCallback(
    async (id: string): Promise<void> => {
      await pauseMutation.mutateAsync(id);
    },
    [pauseMutation],
  );

  const resumeAutomation = useCallback(
    async (id: string): Promise<void> => {
      await resumeMutation.mutateAsync(id);
    },
    [resumeMutation],
  );

  const approveAutomation = useCallback(
    async (id: string): Promise<void> => {
      await approveMutation.mutateAsync(id);
    },
    [approveMutation],
  );

  const deleteAutomation = useCallback(
    async (id: string): Promise<void> => {
      await deleteMutation.mutateAsync(id);
    },
    [deleteMutation],
  );

  const runAutomationNow = useCallback(
    (id: string): Promise<AutomationRun> => runNowMutation.mutateAsync(id),
    [runNowMutation],
  );

  return {
    createAutomation,
    updateAutomation,
    pauseAutomation,
    resumeAutomation,
    approveAutomation,
    deleteAutomation,
    runAutomationNow,
    retryAutomationRun,
    isRetrying: retryMutation.isPending,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isPausing: pauseMutation.isPending,
    isResuming: resumeMutation.isPending,
    isApproving: approveMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isRunningNow: runNowMutation.isPending,
  };
}
