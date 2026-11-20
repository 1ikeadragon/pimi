import React, { useEffect, useState, type ReactNode } from "react";
import { Freeze } from "react-freeze";
import { useRetainedPanelActive } from "@/components/retained-panel";

/**
 * Web only: suspends a hidden chat so its subscribers stop rendering while the
 * model keeps streaming. DOM nodes have no Fabric ownership to lose, so
 * suspension is safe here; native keeps the subtree live (see the base file).
 */
export function RetainedChatContent({ children }: { children: ReactNode }) {
  const active = useRetainedPanelActive();
  const [frozen, setFrozen] = useState(!active);
  // First let every subscriber commit its active=false render: a pane re-render can hand this
  // component the inactive state a commit before the store notifies the rest, and freezing in
  // that batch would discard their renders, leaving an open tooltip's portal on screen. Sync
  // renders flush before the next task, so freezing in a task runs after all of them.
  useEffect(() => {
    if (active) {
      setFrozen(false);
      return undefined;
    }
    const timer = setTimeout(() => setFrozen(true), 0);
    return () => clearTimeout(timer);
  }, [active]);
  return <Freeze freeze={!active && frozen}>{children}</Freeze>;
}
