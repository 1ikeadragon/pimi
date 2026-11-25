import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// The daemon pushes `status.vault_changed` on every change, so these only need a finite stale time
// for the case where a push is missed; a refetch on mount covers a reopened page.
const VAULT_STALE_MS = 30_000;

function vaultRoot(serverId: string) {
  return ["vault", serverId] as const;
}

/** The text of a daemon error without the `requestType=… code=…` suffix the client appends. */
export function vaultErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/ requestType=\S+(?: code=\S+)?$/, "");
}

/** The `vault_<code>` the daemon refused with, when the error is one of its refusals. */
export function vaultErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const match = /code=(vault_\w+)$/.exec(error.message);
  return match ? match[1] : null;
}

/** Keeps every vault query on this page current from the host's change events. */
export function useVaultSync(serverId: string): void {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client || !connected) return;
    const observation = client.observeEvents(["status.vault_changed"]);
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: vaultRoot(serverId) });
    };
    observation.subscribe({
      snapshot: invalidate,
      update: (message) => {
        if (message.type === "status" && message.payload.status === "vault_changed") invalidate();
      },
    });
    return () => {
      void observation
        .release()
        .catch((error: unknown) => console.warn("[Vault] Failed to release change feed", error));
    };
  }, [client, connected, queryClient, serverId]);
}

function requireClient(client: DaemonClient | null): DaemonClient {
  if (!client) throw new Error("The host is not connected.");
  return client;
}

export function useVaultStatus(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: [...vaultRoot(serverId), "status"],
    enabled: connected && client !== null,
    dataShape: "value",
    staleTimeMs: VAULT_STALE_MS,
    queryFn: async () => (await requireClient(client).vaultGetStatus()).status,
  });
}

export function useVaultSecrets(serverId: string, enabled: boolean) {
  const client = useHostRuntimeClient(serverId);
  return useFetchQuery({
    queryKey: [...vaultRoot(serverId), "secrets"],
    enabled: enabled && client !== null,
    dataShape: "list",
    staleTimeMs: VAULT_STALE_MS,
    queryFn: async () => (await requireClient(client).vaultListSecrets()).secrets,
  });
}

export function useVaultGrants(serverId: string, enabled: boolean) {
  const client = useHostRuntimeClient(serverId);
  return useFetchQuery({
    queryKey: [...vaultRoot(serverId), "grants"],
    enabled: enabled && client !== null,
    dataShape: "list",
    staleTimeMs: VAULT_STALE_MS,
    queryFn: async () => (await requireClient(client).vaultListGrants()).grants,
  });
}

export function useVaultRequests(serverId: string, enabled: boolean) {
  const client = useHostRuntimeClient(serverId);
  return useFetchQuery({
    queryKey: [...vaultRoot(serverId), "requests"],
    enabled: enabled && client !== null,
    dataShape: "list",
    staleTimeMs: VAULT_STALE_MS,
    queryFn: async () => (await requireClient(client).vaultListRequests()).requests,
  });
}

export function useVaultAudit(serverId: string, enabled: boolean) {
  const client = useHostRuntimeClient(serverId);
  return useFetchQuery({
    queryKey: [...vaultRoot(serverId), "audit"],
    enabled: enabled && client !== null,
    dataShape: "list",
    staleTimeMs: VAULT_STALE_MS,
    queryFn: async () => (await requireClient(client).vaultListAudit({ limit: 50 })).entries,
  });
}

export function useVaultEnvCandidates(serverId: string, enabled: boolean) {
  const client = useHostRuntimeClient(serverId);
  return useFetchQuery({
    queryKey: [...vaultRoot(serverId), "env-candidates"],
    enabled: enabled && client !== null,
    dataShape: "list",
    staleTimeMs: VAULT_STALE_MS,
    queryFn: async () => (await requireClient(client).vaultEnvListCandidates()).candidates,
  });
}

export function useBitwardenStatus(serverId: string, enabled: boolean) {
  const client = useHostRuntimeClient(serverId);
  return useFetchQuery({
    queryKey: [...vaultRoot(serverId), "bitwarden"],
    enabled: enabled && client !== null,
    dataShape: "value",
    staleTimeMs: VAULT_STALE_MS,
    queryFn: async () => (await requireClient(client).vaultBitwardenGetStatus()).status,
  });
}

/**
 * One daemon action with pending and failure state for the caller to render. The vault queries are
 * refetched afterwards whether it worked or not, because a refusal can mean the state changed.
 */
export function useVaultAction<Input, Result>(
  serverId: string,
  run: (client: DaemonClient, input: Input) => Promise<Result>,
) {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Input) => run(requireClient(client), input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: vaultRoot(serverId) }),
  });
}
