import {
  createContext,
  createElement,
  memo,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ComponentType, ReactElement } from "react";
import type { PluginComponentPointId, PluginComponentPoints } from "@pimi/plugin/client";
import { LayerBoundary } from "./boundary";
import {
  EMPTY_POINT,
  extensionRegistry,
  type AnyComponent,
  type ComponentLayer,
  type PointSnapshot,
} from "./registry";

/**
 * Maps a core component's props to the SDK's props for its point and back. Typed layers see only
 * the SDK shape; unstable layers skip the adapter and see core props.
 */
export interface PointAdapter<CoreProps, PluginProps> {
  toPlugin(core: CoreProps): PluginProps;
  /** Applies the partial a plugin passes to `Original` onto the core props. */
  merge(core: CoreProps, patch: Partial<PluginProps>): CoreProps;
}

type Props = Record<string, unknown>;
type RawAdapter = PointAdapter<Props, Props>;
type RenderableComponent = ComponentType<Props>;

const MEMO_TYPE = Symbol.for("react.memo");

/** Core props of the level being rendered, for `Original` to read. */
const OriginalProps = createContext<Props>({});

interface LevelProps {
  stack: readonly ComponentLayer[];
  index: number;
  Core: RenderableComponent;
  adapter: RawAdapter | undefined;
  point: string;
  props: Props;
}

/** The same chain one position inward, with `props` for the next layer. */
function next(level: Omit<LevelProps, "props">, props: Props): LevelProps {
  return { ...level, index: level.index + 1, props };
}

function Level({ stack, index, Core, adapter, point, props }: LevelProps): ReactElement {
  const layer = stack[index];
  // `Original` has one identity per chain position, so the inner subtree never remounts.
  const Inner = useMemo(() => {
    if (!layer) return null;
    return function Original(patch: Props) {
      const base = useContext(OriginalProps);
      const merged =
        layer.tier === "typed" && adapter ? adapter.merge(base, patch) : { ...base, ...patch };
      return <Level {...next({ stack, index, Core, adapter, point }, merged)} />;
    };
  }, [layer, stack, index, Core, adapter, point]);
  if (!layer || !Inner) return <Core {...props} />;
  const inner = <Level {...next({ stack, index, Core, adapter, point }, props)} />;
  const layerProps = layer.tier === "typed" && adapter ? adapter.toPlugin(props) : props;
  const Layer = layer.Component as RenderableComponent;
  return (
    <OriginalProps.Provider value={props}>
      {createElement(
        LayerBoundary,
        { key: layer.key, owner: layer.owner, point, fallback: inner },
        layer.kind === "wrapper" ? (
          <Layer props={layerProps} Original={Inner}>
            {inner}
          </Layer>
        ) : (
          <Layer {...layerProps} Original={Inner} />
        ),
      )}
    </OriginalProps.Provider>
  );
}

const stacks = new WeakMap<PointSnapshot, readonly ComponentLayer[]>();
function stackOf(snapshot: PointSnapshot): readonly ComponentLayer[] {
  let stack = stacks.get(snapshot);
  if (!stack) {
    stack = snapshot.replacement ? [...snapshot.wrappers, snapshot.replacement] : snapshot.wrappers;
    stacks.set(snapshot, stack);
  }
  return stack;
}

/**
 * Makes a core component an extension point. With nothing registered it renders `Core` with the
 * same props, so it adds one function call and no extra render of `Core`. A `memo` core keeps its
 * comparison: the returned component is memoized with it.
 *
 * Typed points pass an adapter; a point without one is raw-only (`client.unstable.*`).
 */
export function overridable<Id extends PluginComponentPointId, CoreProps extends object>(
  id: Id,
  Core: ComponentType<CoreProps>,
  adapter: PointAdapter<CoreProps, PluginComponentPoints[Id]>,
): ComponentType<CoreProps>;
export function overridable<CoreProps extends object>(
  id: string,
  Core: ComponentType<CoreProps>,
): ComponentType<CoreProps>;
export function overridable(id: string, Core: AnyComponent, adapter?: unknown): AnyComponent {
  const subscribe = (listener: () => void) => extensionRegistry.subscribe(id, listener);
  const getSnapshot = () => extensionRegistry.getSnapshot(id);
  const RenderCore = Core as RenderableComponent;
  const rawAdapter = adapter as unknown as RawAdapter | undefined;
  function Overridable(props: Props) {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    if (snapshot === EMPTY_POINT) return <RenderCore {...props} />;
    return (
      <Level
        stack={stackOf(snapshot)}
        index={0}
        Core={RenderCore}
        adapter={rawAdapter}
        point={id}
        props={props}
      />
    );
  }
  Overridable.displayName = `Overridable(${id})`;
  const coreMemo = Core as {
    $$typeof?: symbol;
    compare?: ((a: Props, b: Props) => boolean) | null;
  };
  if (coreMemo.$$typeof === MEMO_TYPE) {
    return memo(Overridable, coreMemo.compare ?? undefined) as unknown as AnyComponent;
  }
  return Overridable as unknown as AnyComponent;
}
