import type { BackdropSpec } from "./backdrop-spec";

// The backdrop the root renders. The appearance provider sets it (apply-backdrop.ts); the
// window backdrop component subscribes. One store, so a theme switch never remounts the root.
let current: BackdropSpec | null = null;
const listeners = new Set<() => void>();

export const PLUGIN_BACKDROP_APPEARANCE = "plugin-backdrop";

export function getActiveBackdrop(): BackdropSpec | null {
  return current;
}

export function setActiveBackdrop(spec: BackdropSpec | null): void {
  if (current === spec) return;
  current = spec;
  for (const listener of listeners) listener();
}

export function subscribeActiveBackdrop(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
