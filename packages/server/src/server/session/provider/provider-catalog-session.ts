import type pino from "pino";
import { createHash } from "node:crypto";
import { getErrorMessage } from "@pimi/protocol/error-utils";
import { compactProviderSnapshot } from "@pimi/protocol/provider-snapshot-codec";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  isGlobalProviderSnapshotKey,
  resolveSnapshotCwd,
  sameSnapshotRecords,
  type ProviderSnapshotManager,
  type ProviderSnapshot,
  type ProviderSnapshotTransition,
} from "../../agent/provider-snapshot-manager.js";
import {
  filterSelectableAgentModels,
  type AgentFeature,
  type AgentProvider,
  type AgentSessionConfig,
  type ProviderSnapshotEntry,
} from "../../agent/agent-sdk-types.js";
import type { ProviderAvailability } from "../../agent/agent-manager.js";
import { expandTilde } from "../../../utils/path.js";

/**
 * The collaborators a provider-catalog request reaches that are NOT part of the
 * provider domain. The two agent-control reads expose provider availability and draft features the AgentManager owns.
 */
export interface ProviderCatalogSessionHost {
  emit(msg: SessionOutboundMessage): void;
  publishSnapshot(project: () => SessionOutboundMessage | null): void;
  listProviderAvailability(): Promise<ProviderAvailability[]>;
  listDraftFeatures(config: AgentSessionConfig): Promise<AgentFeature[]>;
}

export interface ProviderCatalogSessionOptions {
  host: ProviderCatalogSessionHost;
  providerSnapshotManager: ProviderSnapshotManager;
  logger: pino.Logger;
}

/**
 * A client's provider catalog surface: model / mode / feature listing, the providers
 * snapshot push + pull, and provider diagnostics. The snapshot PUSH (start) and
 * every PULL handler gate visibility through the SAME predicate, so a client sees one
 * consistent provider set across both paths.
 */
export class ProviderCatalogSession {
  private readonly host: ProviderCatalogSessionHost;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly logger: pino.Logger;
  private unsubscribeSnapshotEvents: (() => void) | null = null;

  constructor(options: ProviderCatalogSessionOptions) {
    this.host = options.host;
    this.providerSnapshotManager = options.providerSnapshotManager;
    this.logger = options.logger;
  }

  get isObserving(): boolean {
    return this.unsubscribeSnapshotEvents !== null;
  }

  start(): void {
    if (this.unsubscribeSnapshotEvents) return;
    const handleProviderSnapshotChange = (transition: ProviderSnapshotTransition) => {
      this.host.publishSnapshot(() => {
        const { previous, current } = transition;
        if (sameSnapshotRecords(previous.records, current.records)) return null;
        return { type: "providers_snapshot_update", payload: this.snapshotPayload(current) };
      });
    };
    this.providerSnapshotManager.on("change", handleProviderSnapshotChange);
    this.unsubscribeSnapshotEvents = () => {
      this.providerSnapshotManager.off("change", handleProviderSnapshotChange);
    };
  }

  dispose(): void {
    if (this.unsubscribeSnapshotEvents) {
      this.unsubscribeSnapshotEvents();
      this.unsubscribeSnapshotEvents = null;
    }
  }

  private snapshotPayload(snapshot: ProviderSnapshot, request?: { ifNoneMatch?: string }) {
    const { records } = snapshot;
    const envelope = {
      ...(!isGlobalProviderSnapshotKey(snapshot.cwd) ? { cwd: snapshot.cwd } : {}),
      generatedAt: new Date().toISOString(),
    };
    const snapshotHash = createHash("sha256")
      .update(
        JSON.stringify([
          "paseo.providers-snapshot/1",
          records.map(({ entry, contentHash }) => [entry.provider, contentHash]),
        ]),
      )
      .digest("base64url");
    const fetchedAt = Object.fromEntries(
      records.flatMap(({ entry }) => (entry.fetchedAt ? [[entry.provider, entry.fetchedAt]] : [])),
    );
    const identified = { ...envelope, entries: [], snapshotHash, fetchedAt };
    if (request && request.ifNoneMatch === snapshotHash) {
      return { ...identified, notModified: true as const };
    }
    if (!request) return identified;

    const content = records.map(({ entry: { fetchedAt: _fetchedAt, ...entry } }) => entry);
    return { ...identified, compactSnapshot: compactProviderSnapshot(content) };
  }

  private emitProviderDisabledResponse(
    kind: "models" | "modes",
    provider: AgentProvider,
    requestId: string,
    fetchedAt: string,
  ): void {
    const payload = {
      provider,
      error: `Provider ${provider} is disabled`,
      fetchedAt,
      requestId,
    };
    if (kind === "models") {
      this.host.emit({ type: "list_provider_models_response", payload });
    } else {
      this.host.emit({ type: "list_provider_modes_response", payload });
    }
  }

  async handleListProviderModelsRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_models_request" }>,
  ): Promise<void> {
    const cwd = resolveCatalogRequestCwd(msg.cwd);
    const fetchedAt = new Date().toISOString();

    const entry = await this.getProviderSnapshotEntryForRead(cwd, msg.provider);

    if (!entry) {
      this.host.emit({
        type: "list_provider_models_response",
        payload: {
          provider: msg.provider,
          error: `Unknown provider: ${msg.provider}`,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    if (!entry.enabled) {
      this.emitProviderDisabledResponse("models", msg.provider, msg.requestId, fetchedAt);
      return;
    }

    if (entry.status === "ready") {
      this.host.emit({
        type: "list_provider_models_response",
        payload: {
          provider: msg.provider,
          models: filterSelectableAgentModels(entry.models),
          error: null,
          fetchedAt: entry.fetchedAt ?? fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    const errorMessage =
      entry.status === "error"
        ? (entry.error ?? `Failed to list models for ${msg.provider}`)
        : `Provider ${msg.provider} is not available`;

    this.host.emit({
      type: "list_provider_models_response",
      payload: {
        provider: msg.provider,
        error: errorMessage,
        fetchedAt,
        requestId: msg.requestId,
      },
    });
  }

  async handleListProviderModesRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_modes_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    const cwd = resolveCatalogRequestCwd(msg.cwd);
    const entry = await this.getProviderSnapshotEntryForRead(cwd, msg.provider);

    if (!entry) {
      this.host.emit({
        type: "list_provider_modes_response",
        payload: {
          provider: msg.provider,
          error: `Unknown provider: ${msg.provider}`,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    if (!entry.enabled) {
      this.emitProviderDisabledResponse("modes", msg.provider, msg.requestId, fetchedAt);
      return;
    }

    if (entry.status === "ready") {
      this.host.emit({
        type: "list_provider_modes_response",
        payload: {
          provider: msg.provider,
          modes: entry.modes ?? [],
          error: null,
          fetchedAt: entry.fetchedAt ?? fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    const errorMessage =
      entry.status === "error"
        ? (entry.error ?? `Failed to list modes for ${msg.provider}`)
        : `Provider ${msg.provider} is not available`;

    this.host.emit({
      type: "list_provider_modes_response",
      payload: {
        provider: msg.provider,
        error: errorMessage,
        fetchedAt,
        requestId: msg.requestId,
      },
    });
  }

  private async getProviderSnapshotEntryForRead(
    cwd: string | undefined,
    provider: AgentProvider,
  ): Promise<ProviderSnapshotEntry | undefined> {
    const manager = this.providerSnapshotManager;
    const findEntry = () =>
      manager.getSnapshot(cwd).records.find(({ entry }) => entry.provider === provider)?.entry;

    let entry = findEntry();
    if (entry && !entry.enabled) {
      return entry;
    }
    if (!entry || entry.status === "loading") {
      // Awaits the in-flight warmup (deduped per-cwd) so old clients still get
      // a resolved answer rather than a loading placeholder.
      await manager.warmUpSnapshotForCwd({ cwd, providers: [provider] });
      entry = findEntry();
    }
    return entry;
  }

  private buildDraftAgentSessionConfig(draftConfig: {
    provider: AgentProvider;
    cwd: string;
    modeId?: string;
    model?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
  }): AgentSessionConfig {
    return {
      provider: draftConfig.provider,
      cwd: expandTilde(draftConfig.cwd),
      ...(draftConfig.modeId ? { modeId: draftConfig.modeId } : {}),
      ...(draftConfig.model ? { model: draftConfig.model } : {}),
      ...(draftConfig.thinkingOptionId ? { thinkingOptionId: draftConfig.thinkingOptionId } : {}),
      ...(draftConfig.featureValues ? { featureValues: draftConfig.featureValues } : {}),
    };
  }

  async handleListProviderFeaturesRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_features_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const sessionConfig = this.buildDraftAgentSessionConfig(msg.draftConfig);
      const features = await this.host.listDraftFeatures(sessionConfig);
      this.host.emit({
        type: "list_provider_features_response",
        payload: {
          provider: msg.draftConfig.provider,
          features,
          error: null,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, provider: msg.draftConfig.provider, draftConfig: msg.draftConfig },
        `Failed to list features for ${msg.draftConfig.provider}`,
      );
      this.host.emit({
        type: "list_provider_features_response",
        payload: {
          provider: msg.draftConfig.provider,
          error: getErrorMessage(error),
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleListAvailableProvidersRequest(
    msg: Extract<SessionInboundMessage, { type: "list_available_providers_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const providers = await this.host.listProviderAvailability();
      this.host.emit({
        type: "list_available_providers_response",
        payload: {
          providers,
          error: null,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to list provider availability");
      this.host.emit({
        type: "list_available_providers_response",
        payload: {
          providers: [],
          error: getErrorMessage(error),
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleGetProvidersSnapshotRequest(
    msg: Extract<SessionInboundMessage, { type: "get_providers_snapshot_request" }>,
  ): Promise<void> {
    const cwd = msg.cwd?.trim() ? resolveSnapshotCwd(expandTilde(msg.cwd)) : undefined;
    const snapshot = this.providerSnapshotManager.getSnapshot(cwd);
    this.host.emit({
      type: "get_providers_snapshot_response",
      payload: {
        ...this.snapshotPayload(snapshot, { ifNoneMatch: msg.ifNoneMatch }),
        requestId: msg.requestId,
      },
    });
  }

  async handleRefreshProvidersSnapshotRequest(
    msg: Extract<SessionInboundMessage, { type: "refresh_providers_snapshot_request" }>,
  ): Promise<void> {
    if (msg.cwd) {
      await this.providerSnapshotManager.refreshSnapshotForCwd({
        cwd: expandTilde(msg.cwd),
        providers: msg.providers,
      });
    } else {
      await this.providerSnapshotManager.refreshSettingsSnapshot({
        providers: msg.providers,
      });
    }
    this.host.emit({
      type: "refresh_providers_snapshot_response",
      payload: {
        acknowledged: true,
        requestId: msg.requestId,
      },
    });
  }

  async handleHarnessUpdatesRequest(
    msg: Extract<SessionInboundMessage, { type: "provider.harness_updates.check.request" }>,
  ): Promise<void> {
    const updates = await this.providerSnapshotManager.checkHarnessUpdates(msg.force);
    this.host.emit({
      type: "provider.harness_updates.check.response",
      payload: {
        updates,
        requestId: msg.requestId,
      },
    });
  }

  async handleProviderDiagnosticRequest(
    msg: Extract<SessionInboundMessage, { type: "provider_diagnostic_request" }>,
  ): Promise<void> {
    try {
      const { diagnostic } = await this.providerSnapshotManager.getProviderDiagnostic(msg.provider);
      this.host.emit({
        type: "provider_diagnostic_response",
        payload: {
          provider: msg.provider,
          diagnostic,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        { err, provider: msg.provider },
        `Failed to get provider diagnostic for ${msg.provider}`,
      );
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to get provider diagnostic: ${err.message}`,
          code: "provider_diagnostic_failed",
        },
      });
    }
  }
}

function resolveCatalogRequestCwd(cwd?: string | null): string | undefined {
  const trimmed = cwd?.trim();
  return trimmed ? expandTilde(trimmed) : undefined;
}
