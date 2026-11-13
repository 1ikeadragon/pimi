import type { ComponentType } from "react";

/** Plugin and core components have unrelated prop types; the registry only stores and hands them back. */
// eslint-disable-next-line typescript-eslint/no-explicit-any -- props are unrelated across points; `never` rejects class components
export type AnyComponent = ComponentType<any>;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Typed layers get the SDK's props for the point; unstable layers get Pimi's internal props. */
export type LayerTier = "typed" | "unstable";

export interface ComponentLayer {
  /** Unique per registration, so a boundary resets when its layer is replaced. */
  readonly key: number;
  readonly kind: "replacement" | "wrapper";
  readonly owner: string;
  readonly order: number;
  readonly tier: LayerTier;
  readonly Component: AnyComponent;
}

export interface PointSnapshot {
  readonly replacement: ComponentLayer | null;
  /** Outermost first. */
  readonly wrappers: readonly ComponentLayer[];
}

export interface SlotRegistration {
  readonly key: number;
  readonly owner: string;
  readonly id: string;
  readonly order: number;
  readonly Component: AnyComponent;
}

export interface ExtensionConflict {
  readonly point: string;
  readonly winner: string;
  readonly losers: readonly string[];
}

export interface ExtensionError {
  readonly owner: string;
  readonly point: string;
  readonly message: string;
}

export interface RegistrationOptions {
  order?: number;
  tier?: LayerTier;
}

/** What no registration looks like. One shared reference, so a point with nothing never re-renders. */
export const EMPTY_POINT: PointSnapshot = Object.freeze({ replacement: null, wrappers: [] });
const EMPTY_SLOT: readonly SlotRegistration[] = Object.freeze([]);
const EMPTY_LIST: readonly never[] = Object.freeze([]);

function compareLayers(left: ComponentLayer, right: ComponentLayer): number {
  return left.order - right.order || compareText(left.owner, right.owner) || left.key - right.key;
}

/**
 * Where plugins register component layers and slot items. Core components read it through
 * `overridable()` and `<Slot/>`; nothing here knows how plugins load.
 *
 * Per-point snapshots keep a stable reference until that point changes, so installing a sidebar
 * override never re-renders chat rows.
 */
class ExtensionRegistry {
  private nextKey = 1;
  private safeMode = false;
  private readonly layers = new Map<string, ComponentLayer[]>();
  private readonly slotItems = new Map<string, SlotRegistration[]>();
  private readonly pointSnapshots = new Map<string, PointSnapshot>();
  private readonly slotSnapshots = new Map<string, readonly SlotRegistration[]>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly metaListeners = new Set<() => void>();
  private readonly errors = new Map<string, ExtensionError>();
  private conflictSnapshot: readonly ExtensionConflict[] = EMPTY_LIST;
  private errorSnapshot: readonly ExtensionError[] = EMPTY_LIST;

  /** Safe mode serves empty snapshots, so every point renders Pimi's own component. */
  setSafeMode(enabled: boolean): void {
    if (this.safeMode === enabled) return;
    this.safeMode = enabled;
    for (const point of this.listeners.keys()) this.notify(point);
  }

  setOverride(
    pointId: string,
    owner: string,
    Component: AnyComponent,
    options: RegistrationOptions = {},
  ): () => void {
    return this.addLayer(pointId, "replacement", owner, Component, options);
  }

  addWrapper(
    pointId: string,
    owner: string,
    Component: AnyComponent,
    options: RegistrationOptions = {},
  ): () => void {
    return this.addLayer(pointId, "wrapper", owner, Component, options);
  }

  addSlotItem(
    slotId: string,
    owner: string,
    item: { id: string; order?: number; Component: AnyComponent },
  ): () => void {
    const registration: SlotRegistration = {
      key: this.nextKey++,
      owner,
      id: item.id,
      order: item.order ?? 0,
      Component: item.Component,
    };
    const channel = `slot:${slotId}`;
    const items = [...(this.slotItems.get(slotId) ?? []), registration].sort(
      (left, right) =>
        left.order - right.order ||
        compareText(left.owner, right.owner) ||
        compareText(left.id, right.id),
    );
    this.slotItems.set(slotId, items);
    this.slotSnapshots.set(slotId, items);
    this.notify(channel);
    return () => {
      const current = this.slotItems.get(slotId) ?? [];
      const remaining = current.filter((candidate) => candidate !== registration);
      if (remaining.length === current.length) return;
      if (remaining.length === 0) {
        this.slotItems.delete(slotId);
        this.slotSnapshots.delete(slotId);
      } else {
        this.slotItems.set(slotId, remaining);
        this.slotSnapshots.set(slotId, remaining);
      }
      this.notify(channel);
    };
  }

  private addLayer(
    pointId: string,
    kind: ComponentLayer["kind"],
    owner: string,
    Component: AnyComponent,
    options: RegistrationOptions,
  ): () => void {
    const layer: ComponentLayer = {
      key: this.nextKey++,
      kind,
      owner,
      order: options.order ?? 0,
      tier: options.tier ?? "typed",
      Component,
    };
    this.layers.set(pointId, [...(this.layers.get(pointId) ?? []), layer]);
    this.rebuild(pointId);
    return () => {
      const current = this.layers.get(pointId) ?? [];
      const remaining = current.filter((candidate) => candidate !== layer);
      if (remaining.length === current.length) return;
      if (remaining.length === 0) this.layers.delete(pointId);
      else this.layers.set(pointId, remaining);
      this.rebuild(pointId);
    };
  }

  private rebuild(pointId: string): void {
    const all = this.layers.get(pointId) ?? [];
    const replacements = all.filter((layer) => layer.kind === "replacement").sort(compareLayers);
    const wrappers = all.filter((layer) => layer.kind === "wrapper").sort(compareLayers);
    if (replacements.length === 0 && wrappers.length === 0) this.pointSnapshots.delete(pointId);
    else
      this.pointSnapshots.set(pointId, {
        replacement: replacements.at(-1) ?? null,
        wrappers,
      });
    this.refreshConflicts();
    this.notify(pointId);
  }

  private refreshConflicts(): void {
    const conflicts: ExtensionConflict[] = [];
    for (const [point, all] of this.layers) {
      const replacements = all.filter((layer) => layer.kind === "replacement").sort(compareLayers);
      const owners = [...new Set(replacements.map((layer) => layer.owner))];
      if (owners.length > 1) {
        conflicts.push({ point, winner: owners[owners.length - 1], losers: owners.slice(0, -1) });
      }
    }
    conflicts.sort((left, right) => (left.point < right.point ? -1 : 1));
    this.conflictSnapshot = conflicts.length === 0 ? EMPTY_LIST : conflicts;
    for (const listener of this.metaListeners) listener();
  }

  getSnapshot = (pointId: string): PointSnapshot => {
    if (this.safeMode) return EMPTY_POINT;
    return this.pointSnapshots.get(pointId) ?? EMPTY_POINT;
  };

  getSlotItems = (slotId: string): readonly SlotRegistration[] => {
    if (this.safeMode) return EMPTY_SLOT;
    return this.slotSnapshots.get(slotId) ?? EMPTY_SLOT;
  };

  subscribe = (pointId: string, listener: () => void): (() => void) =>
    this.listen(pointId, listener);

  subscribeSlot = (slotId: string, listener: () => void): (() => void) =>
    this.listen(`slot:${slotId}`, listener);

  private listen(channel: string, listener: () => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(channel) === set) this.listeners.delete(channel);
    };
  }

  private notify(channel: string): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const listener of Array.from(set)) listener();
  }

  /** Records a layer that threw while rendering, once per owner and point. */
  reportError(owner: string, point: string, error: unknown): void {
    const key = `${owner}\0${point}`;
    const message = error instanceof Error ? error.message : String(error);
    if (this.errors.get(key)?.message === message) return;
    this.errors.set(key, { owner, point, message });
    this.errorSnapshot = [...this.errors.values()];
    for (const listener of this.metaListeners) listener();
  }

  /** Forget an owner's errors, for example after its plugin reloads. */
  clearErrors(owner: string): void {
    let changed = false;
    for (const [key, error] of this.errors) {
      if (error.owner !== owner) continue;
      this.errors.delete(key);
      changed = true;
    }
    if (!changed) return;
    this.errorSnapshot = this.errors.size === 0 ? EMPTY_LIST : [...this.errors.values()];
    for (const listener of this.metaListeners) listener();
  }

  getConflicts = (): readonly ExtensionConflict[] => this.conflictSnapshot;
  getErrors = (): readonly ExtensionError[] => this.errorSnapshot;

  /** Changes to conflicts and errors, for the Plugins page. */
  subscribeMeta = (listener: () => void): (() => void) => {
    this.metaListeners.add(listener);
    return () => {
      this.metaListeners.delete(listener);
    };
  };

  /** Points an owner has registered on, for the Plugins page. */
  getOwnerPoints(owner: string): readonly string[] {
    const points = new Set<string>();
    for (const [point, all] of this.layers) {
      if (all.some((layer) => layer.owner === owner)) points.add(point);
    }
    for (const [slot, all] of this.slotItems) {
      if (all.some((item) => item.owner === owner)) points.add(`slot:${slot}`);
    }
    return [...points].sort();
  }
}

export const extensionRegistry = new ExtensionRegistry();
