import type { ProviderSnapshotEntry } from "@pimi/protocol/agent-types";
import { createStore } from "zustand/vanilla";

export interface ProviderSnapshotIcon {
  iconSvg?: string;
  baseProvider?: string;
}

export const providerSnapshotIcons = createStore<
  ReadonlyMap<string, ReadonlyMap<string, ProviderSnapshotIcon>>
>(() => new Map());

export function replaceProviderSnapshotIcons(
  serverId: string,
  entries: readonly Pick<ProviderSnapshotEntry, "provider" | "iconSvg" | "baseProvider">[],
): void {
  const icons = new Map<string, ProviderSnapshotIcon>();
  for (const { provider, iconSvg, baseProvider } of entries) {
    if (iconSvg || baseProvider) icons.set(provider, { iconSvg, baseProvider });
  }
  providerSnapshotIcons.setState((previous) => new Map(previous).set(serverId, icons), true);
}
