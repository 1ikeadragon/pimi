import React, {
  createContext,
  memo,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

// Activity is a small store behind a context whose value never changes. A changing context value
// makes React walk the whole subtree under the provider to find consumers, which cost tens of
// milliseconds for a workspace; consumers that subscribe to the store re-render alone.
interface RetainedPanelActivityStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => boolean;
}

const ALWAYS_ACTIVE_STORE: RetainedPanelActivityStore = {
  subscribe: () => () => {},
  getSnapshot: () => true,
};

const RetainedPanelActiveContext = createContext<RetainedPanelActivityStore>(ALWAYS_ACTIVE_STORE);

export function useRetainedPanelActive(): boolean {
  const store = useContext(RetainedPanelActiveContext);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Like `useRetainedPanelActive`, but only re-renders for activity changes while `watch` is true;
 * otherwise it reports active. For a component whose activity matters only while something is
 * showing, such as an open tooltip: a workspace has hundreds of them, and each would re-render
 * on every switch.
 */
export function useRetainedPanelActiveWhile(watch: boolean): boolean {
  const store = useContext(RetainedPanelActiveContext);
  const getSnapshot = () => !watch || store.getSnapshot();
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

function createActivityStore(
  parent: RetainedPanelActivityStore,
  isActive: () => boolean,
): RetainedPanelActivityStore & { notify: () => void } {
  const listeners = new Set<() => void>();
  const getSnapshot = () => parent.getSnapshot() && isActive();
  // Listeners compare snapshots themselves, so every change is forwarded.
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  let unsubscribeParent: (() => void) | null = null;
  return {
    getSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      unsubscribeParent ??= parent.subscribe(notify);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeParent?.();
          unsubscribeParent = null;
        }
      };
    },
    notify,
  };
}

interface RetainedPanelProps {
  active: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface RetainedPanelActivityProps {
  active: boolean;
  children: ReactNode;
}

export function RetainedPanelActivity({ active, children }: RetainedPanelActivityProps) {
  const parent = useContext(RetainedPanelActiveContext);
  const activeRef = useRef(active);
  activeRef.current = active;
  const store = useMemo(() => createActivityStore(parent, () => activeRef.current), [parent]);
  useLayoutEffect(() => {
    store.notify();
  }, [store, active]);
  return <RetainedPanelActiveContext value={store}>{children}</RetainedPanelActiveContext>;
}

/**
 * Keeps expensive panel state mounted without letting an inactive panel render
 * on screen. The stable, non-collapsible native root is intentional: retained
 * panels must not detach or reparent their native descendants when visibility
 * changes.
 */
export const RetainedPanel = memo(function RetainedPanel({
  active,
  children,
  style,
  testID,
}: RetainedPanelProps) {
  const visibleStyle = StyleSheet.compose<ViewStyle, ViewStyle, ViewStyle>(styles.root, style);
  const panelStyle = active
    ? visibleStyle
    : StyleSheet.compose<ViewStyle, ViewStyle, ViewStyle>(visibleStyle, styles.hidden);

  return (
    <RetainedPanelActivity active={active}>
      <View
        collapsable={false}
        pointerEvents={active ? "auto" : "none"}
        style={panelStyle}
        testID={testID}
      >
        {children}
      </View>
    </RetainedPanelActivity>
  );
});

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  hidden: {
    display: "none",
  },
});
