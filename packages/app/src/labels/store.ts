import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import {
  labelTargetKey,
  type Label,
  type LabelColor,
  type LabelTarget,
} from "@pimi/protocol/labels";
import { useMemo } from "react";
import { create } from "zustand";
import { HostLabelReplica } from "./internal/replica";
import { LabelManagerModel, LabelPickerModel } from "./internal/workflow-model";
import { i18n } from "@/i18n/i18next";

export type { Label, LabelColor, LabelTarget } from "@pimi/protocol/labels";
export { labelTargetKey } from "@pimi/protocol/labels";
export { labelErrorMessage } from "./internal/workflow-model";
export type {
  LabelManagerDraft,
  LabelManagerHost,
  LabelManagerSnapshot,
  LabelPickerModelSnapshot,
  LabelPickerRow,
} from "./internal/workflow-model";

export function createLabelPickerModel(
  dependencies: ConstructorParameters<typeof LabelPickerModel>[0],
): LabelPickerModel {
  return new LabelPickerModel(dependencies);
}

export function createLabelManagerModel(
  dependencies: ConstructorParameters<typeof LabelManagerModel>[0],
): LabelManagerModel {
  return new LabelManagerModel(dependencies);
}

export interface LabelHostSnapshot {
  serverId: string;
  labels: readonly Label[];
  /** `labelTargetKey` -> label ids. Absent means the target carries nothing. */
  assignments: Readonly<Record<string, readonly string[]>>;
  status: "offline" | "online";
  error: string | null;
}

interface LabelState {
  hosts: Record<string, LabelHostSnapshot>;
  setHost: (host: LabelHostSnapshot) => void;
}

export const useLabelStore = create<LabelState>((set) => ({
  hosts: {},
  setHost: (host) => set((state) => ({ hosts: { ...state.hosts, [host.serverId]: host } })),
}));

const EMPTY_IDS: readonly string[] = [];
const EMPTY_LABELS: readonly Label[] = [];

export interface LabelProjection {
  hosts: readonly LabelHostSnapshot[];
  /** Every label on every online host, by name. Ids are per host and never merged. */
  labels: readonly Label[];
  targetHost: LabelHostSnapshot | undefined;
}

/**
 * A connected host with a failed catalog request can still accept label mutations, but its
 * replica is not evidence that a persisted filter names a deleted label. Reconciliation is
 * destructive, so wait until every connected catalog has loaded successfully.
 */
export function hasAuthoritativeLabelCatalog(hosts: readonly LabelHostSnapshot[]): boolean {
  return (
    hosts.some((host) => host.status === "online") &&
    !hosts.some((host) => host.status === "online" && host.error !== null)
  );
}

export function projectLabels(
  hostsById: Readonly<Record<string, LabelHostSnapshot>>,
  targetServerId?: string,
): LabelProjection {
  const hosts = Object.values(hostsById);
  const labels = hosts
    .filter((host) => host.status === "online")
    .flatMap((host) => host.labels)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  return { hosts, labels, targetHost: targetServerId ? hostsById[targetServerId] : undefined };
}

/** Reactive cross-host projection, for surfaces that span hosts (a filter page, a manager). */
export function useLabelProjection(targetServerId?: string): LabelProjection {
  const hosts = useLabelStore((state) => state.hosts);
  return useMemo(() => projectLabels(hosts, targetServerId), [hosts, targetServerId]);
}

/** One host's catalog and assignments, or undefined before its first snapshot. */
export function useHostLabels(serverId: string): LabelHostSnapshot | undefined {
  return useLabelStore((state) => state.hosts[serverId]);
}

/** The label ids one target carries. A keyed selector: only that target's change re-renders. */
export function useTargetLabelIds(serverId: string, target: LabelTarget | null): readonly string[] {
  const key = target ? labelTargetKey(target) : null;
  return useLabelStore((state) =>
    key ? (state.hosts[serverId]?.assignments[key] ?? EMPTY_IDS) : EMPTY_IDS,
  );
}

/**
 * The labels a target carries, in assignment order, resolved against the target's own host.
 * Two hosts are free to give the same name different colors, so no cross-host lookup is ever
 * consulted. An id the catalog does not know yet (first snapshot in flight) is dropped.
 */
export function useTargetLabels(serverId: string, target: LabelTarget | null): readonly Label[] {
  const ids = useTargetLabelIds(serverId, target);
  const catalog = useLabelStore((state) => state.hosts[serverId]?.labels);
  return useMemo(() => resolveLabels(catalog, ids), [catalog, ids]);
}

export function resolveLabels(
  catalog: readonly Label[] | undefined,
  ids: readonly string[],
): readonly Label[] {
  if (!catalog || ids.length === 0) return EMPTY_LABELS;
  const byId = new Map(catalog.map((label) => [label.id, label]));
  return ids.flatMap((id) => {
    const label = byId.get(id);
    return label ? [label] : [];
  });
}

/** A host's catalog and `labelTargetKey` -> ids map, the shape list screens join against. */
export interface HostLabelIndex {
  labels: readonly Label[];
  byTarget: ReadonlyMap<string, readonly string[]>;
}

const EMPTY_INDEX: HostLabelIndex = { labels: EMPTY_LABELS, byTarget: new Map() };
const indexCache = new WeakMap<LabelHostSnapshot, HostLabelIndex>();

function indexOf(host: LabelHostSnapshot | undefined): HostLabelIndex {
  if (!host) return EMPTY_INDEX;
  let index = indexCache.get(host);
  if (!index) {
    index = { labels: host.labels, byTarget: new Map(Object.entries(host.assignments)) };
    indexCache.set(host, index);
  }
  return index;
}

/**
 * The label index of several hosts at once, for screens that group or filter many targets (the
 * Tasks list). Hosts without a snapshot yet map to an empty index.
 */
export function useLabelIndex(serverIds: readonly string[]): ReadonlyMap<string, HostLabelIndex> {
  const hosts = useLabelStore((state) => state.hosts);
  const key = serverIds.join("\0");
  return useMemo(
    () => new Map(serverIds.map((serverId) => [serverId, indexOf(hosts[serverId])])),
    // `key` is the identity of `serverIds`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [hosts, key],
  );
}

interface HostConnection {
  client: DaemonClient;
  replica: HostLabelReplica;
  unsubscribe: () => void;
}

class LabelsController {
  private readonly replicas = new Map<string, HostLabelReplica>();
  private readonly connections = new Map<string, HostConnection>();

  async connect(input: { serverId: string; client: DaemonClient }): Promise<void> {
    const existing = this.connections.get(input.serverId);
    if (existing?.client === input.client) {
      await this.refresh(input.serverId);
      return;
    }
    this.disconnect(input.serverId);
    const replica = this.replicas.get(input.serverId) ?? new HostLabelReplica();
    this.replicas.set(input.serverId, replica);

    const subscription = input.client.observeLabels();
    const connection: HostConnection = {
      client: input.client,
      replica,
      unsubscribe: () => {
        void subscription.release().catch(() => undefined);
      },
    };
    this.connections.set(input.serverId, connection);
    subscription.subscribe({
      snapshot: (payload) => {
        replica.applyList(payload);
        this.publish(input.serverId, replica, "online", null);
      },
      update: (message) => {
        if (message.type !== "label.update") return;
        replica.applyUpdate(message);
        this.publish(input.serverId, replica, "online", null);
      },
      error: (error) => {
        this.publish(
          input.serverId,
          replica,
          "online",
          error instanceof Error ? error.message : i18n.t("workspaceLabels.errors.load"),
        );
      },
    });
    await subscription.ready;
  }

  disconnect(serverId: string): void {
    this.connections.get(serverId)?.unsubscribe();
    this.connections.delete(serverId);
    const replica = this.replicas.get(serverId);
    if (replica) this.publish(serverId, replica, "offline", null);
  }

  setAssignment(input: {
    serverId: string;
    target: LabelTarget;
    labelId: string;
    assigned: boolean;
  }) {
    return this.mutate(input.serverId, (client) =>
      client.labelAssignmentSet({
        target: input.target,
        labelId: input.labelId,
        assigned: input.assigned,
      }),
    );
  }

  async create(input: { serverId: string; name: string; color: LabelColor }): Promise<Label> {
    const response = await this.mutate(input.serverId, (client) =>
      client.labelCreate({ name: input.name, color: input.color }),
    );
    return response.label;
  }

  update(input: { serverId: string; labelId: string; name?: string; color?: LabelColor }) {
    return this.mutate(input.serverId, (client) =>
      client.labelUpdate({ labelId: input.labelId, name: input.name, color: input.color }),
    );
  }

  delete(input: { serverId: string; labelId: string }) {
    return this.mutate(input.serverId, (client) => client.labelDelete({ labelId: input.labelId }));
  }

  inspectDelete(input: { serverId: string; labelId: string }) {
    return this.mutate(input.serverId, (client) =>
      client.labelDeleteInspect({ labelId: input.labelId }),
    );
  }

  private async refresh(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    try {
      const payload = await connection.client.labelList();
      if (this.connections.get(serverId) !== connection) return;
      connection.replica.applyList(payload);
      this.publish(serverId, connection.replica, "online", null);
    } catch (error) {
      if (this.connections.get(serverId) !== connection) throw error;
      this.publish(
        serverId,
        connection.replica,
        "online",
        error instanceof Error ? error.message : i18n.t("workspaceLabels.errors.load"),
      );
      throw error;
    }
  }

  private async mutate<T>(serverId: string, operation: (client: DaemonClient) => Promise<T>) {
    const connection = this.connections.get(serverId);
    if (!connection) throw new Error(i18n.t("workspaceLabels.manage.offline"));
    try {
      return await operation(connection.client);
    } catch (error) {
      await this.refresh(serverId).catch(() => undefined);
      throw error;
    }
  }

  private publish(
    serverId: string,
    replica: HostLabelReplica,
    status: LabelHostSnapshot["status"],
    error: string | null,
  ): void {
    const snapshot = replica.snapshot();
    useLabelStore.getState().setHost({
      serverId,
      labels: snapshot.labels,
      assignments: snapshot.assignments,
      status,
      error,
    });
  }
}

export const labels = new LabelsController();
