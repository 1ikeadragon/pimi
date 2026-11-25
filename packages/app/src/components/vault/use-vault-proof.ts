import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { VaultQuickUnlockPurpose } from "@pimi/protocol/vault/rpc-schemas";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { readPassphrase, hasStoredPassphrase } from "@/vault/biometric-passphrase";
import { useFetchQuery } from "@/data/query";
import { useVaultStatus, vaultErrorCode } from "@/screens/settings/vault/use-vault";

/**
 * How this device proves the passphrase. Touch ID only on the Mac that runs the daemon: a prompt
 * for a daemon on another machine would appear where the user is not. The phone keeps a passphrase
 * behind Face ID or a fingerprint (opt-in); everything else types it.
 */
export type ProofPath = "touch-id" | "phone-biometric" | "passphrase";

export type ProofOutcome = "proven" | "cancelled" | "needs-passphrase";

export function useProofPath(serverId: string): ProofPath {
  const status = useVaultStatus(serverId);
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const stored = useFetchQuery({
    queryKey: ["vault-biometric", serverId],
    dataShape: "value",
    staleTimeMs: 60_000,
    queryFn: () => hasStoredPassphrase(serverId),
  });
  if (status.data?.quickUnlock === "on" && isLocalDaemon) return "touch-id";
  if (stored.data === true) return "phone-biometric";
  return "passphrase";
}

interface ProveParams {
  client: DaemonClient;
  serverId: string;
  path: ProofPath;
  purpose: VaultQuickUnlockPurpose;
  /** The text the phone's biometric prompt shows. */
  prompt: string;
}

/** Marks this connection as the operator (and unlocks the vault for `unlock`) without typing. */
export async function proveWithoutTyping(params: ProveParams): Promise<ProofOutcome> {
  const { client, serverId, path, purpose, prompt } = params;
  if (path === "touch-id") {
    try {
      await client.vaultQuickUnlockProve({ purpose });
      return "proven";
    } catch (error) {
      if (vaultErrorCode(error) === "vault_cancelled") return "cancelled";
      throw error;
    }
  }
  if (path === "phone-biometric") {
    const read = await readPassphrase(serverId, prompt);
    if (read.kind === "cancelled") return "cancelled";
    if (read.kind !== "ok") return "needs-passphrase";
    if (purpose === "unlock") await client.vaultUnlock({ passphrase: read.passphrase });
    else await client.vaultAuthorize({ passphrase: read.passphrase });
    return "proven";
  }
  return "needs-passphrase";
}
