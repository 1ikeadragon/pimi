import { useEffect, useState } from "react";
import type { AttackRun } from "@pimi/protocol/attack/types";

/**
 * The run's spent runtime, ticking each second while it runs. The daemon sends settled time and
 * `resumedAt`; the open stretch is counted here, so the meter moves from the first second.
 */
export function useAttackRuntimeMs(run: AttackRun): number {
  const running = run.status === "running" && run.resumedAt !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!running || run.resumedAt === null) return run.spent.runtimeMs;
  return run.spent.runtimeMs + Math.max(0, now - new Date(run.resumedAt).getTime());
}

export function formatClock(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
