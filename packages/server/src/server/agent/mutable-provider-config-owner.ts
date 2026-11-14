import { isDeepStrictEqual } from "node:util";

import { detectProviderInstalls } from "../provider-config-dirs.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import type {
  AgentManagerProviderState,
  ProviderSnapshotManager,
} from "./provider-snapshot-manager.js";

// How often the host is rescanned for signed-in installs, so one that is signed out or removed
// leaves the picker, and a new one joins it, without a daemon restart.
const DETECTED_INSTALLS_SCAN_MS = 30_000;

export function attachMutableProviderConfigOwner(options: {
  store: DaemonConfigStore;
  providerSnapshotManager: ProviderSnapshotManager;
  updateProviderRegistry: (state: AgentManagerProviderState) => void;
}): () => void {
  let commitPendingProviderChange: (() => void) | null = null;

  const unsubscribeApply = options.store.onApply((config, previous, details) => {
    if (isDeepStrictEqual(config.providers, previous.providers)) return () => undefined;

    const previousAgentManagerState =
      options.providerSnapshotManager.getAgentManagerProviderState();
    const prepared = options.providerSnapshotManager.prepareMutableProviderConfig(
      config.providers,
      {
        removeProviders: details.removedProviders,
        replace: true,
      },
    );
    try {
      options.updateProviderRegistry(prepared.agentManagerState);
    } catch (error) {
      options.updateProviderRegistry(previousAgentManagerState);
      throw error;
    }
    commitPendingProviderChange = prepared.commit;

    return () => {
      commitPendingProviderChange = null;
      options.updateProviderRegistry(previousAgentManagerState);
    };
  });
  const unsubscribeChange = options.store.onChange(() => {
    const commit = commitPendingProviderChange;
    commitPendingProviderChange = null;
    commit?.();
  });

  let scanning = false;
  const scanInstalls = async (): Promise<void> => {
    // A config apply in flight owns the provider state until it commits.
    if (scanning || commitPendingProviderChange) return;
    scanning = true;
    try {
      const prepared = options.providerSnapshotManager.prepareDetectedInstalls(
        await detectProviderInstalls(),
      );
      if (!prepared || commitPendingProviderChange) return;
      options.updateProviderRegistry(prepared.agentManagerState);
      prepared.commit();
    } catch {
      // The next scan retries; a failed scan leaves the registered providers as they were.
    } finally {
      scanning = false;
    }
  };
  void scanInstalls();
  const scanTimer = setInterval(() => void scanInstalls(), DETECTED_INSTALLS_SCAN_MS);
  scanTimer.unref();

  return () => {
    clearInterval(scanTimer);
    unsubscribeApply();
    unsubscribeChange();
  };
}
