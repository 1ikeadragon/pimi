import type { DesktopTargetGuard } from "@pimi/protocol/desktop-target/rpc-schemas";

// What every platform's implementation shares. The confinement rules themselves live next to each
// implementation (mac/guard.ts, win/guard-win.ts); they are pure functions the main process applies
// on every call, and the daemon builds the guard from the run record. An agent never supplies one.

export type DesktopGuard = DesktopTargetGuard;

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A window-relative point is inside the window's frame. */
export function pointInFrame(point: { x: number; y: number }, frame: Frame): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < frame.width &&
    point.y < frame.height
  );
}
