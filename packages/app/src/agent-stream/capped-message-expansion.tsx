import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";

type Listener = () => void;

/**
 * Which capped assistant messages the user expanded to full length. The web timeline unmounts rows
 * outside its window and memoizes history rows, so the state lives here and each message subscribes
 * to its own id. Expanding is one-way and only grows on a user press.
 */
export interface CappedMessageExpansion {
  isExpanded(messageId: string): boolean;
  expand(messageId: string): void;
  subscribe(messageId: string, listener: Listener): () => void;
}

function createCappedMessageExpansion(): CappedMessageExpansion {
  const expanded = new Set<string>();
  const listeners = new Map<string, Set<Listener>>();
  return {
    isExpanded: (messageId) => expanded.has(messageId),
    expand(messageId) {
      if (expanded.has(messageId)) return;
      expanded.add(messageId);
      for (const listener of listeners.get(messageId) ?? []) listener();
    },
    subscribe(messageId, listener) {
      let set = listeners.get(messageId);
      if (!set) {
        set = new Set();
        listeners.set(messageId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(messageId);
      };
    },
  };
}

export const CappedMessageExpansionContext = createContext<CappedMessageExpansion | null>(null);

/** One store per viewed agent; switching agents starts with every message capped. */
export function useAgentCappedMessageExpansion(agentId: string): CappedMessageExpansion {
  const [owner, setOwner] = useState(() => ({
    agentId,
    expansion: createCappedMessageExpansion(),
  }));
  if (owner.agentId === agentId) return owner.expansion;
  const next = { agentId, expansion: createCappedMessageExpansion() };
  setOwner(next);
  return next.expansion;
}

const subscribeNone = () => () => {};

/** Outside a timeline there is no store, so the expansion lasts as long as the component. */
export function useCappedMessageExpanded(messageId: string): {
  expanded: boolean;
  expand: () => void;
} {
  const expansion = useContext(CappedMessageExpansionContext);
  const [localExpanded, setLocalExpanded] = useState(false);
  const subscribe = useCallback(
    (listener: Listener) => expansion?.subscribe(messageId, listener) ?? subscribeNone(),
    [expansion, messageId],
  );
  const getSnapshot = useCallback(
    () => expansion?.isExpanded(messageId) ?? false,
    [expansion, messageId],
  );
  const storedExpanded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const expand = useCallback(() => {
    if (expansion) expansion.expand(messageId);
    else setLocalExpanded(true);
  }, [expansion, messageId]);
  return { expanded: expansion ? storedExpanded : localExpanded, expand };
}
