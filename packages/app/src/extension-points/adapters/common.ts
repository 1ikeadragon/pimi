import type { PointAdapter } from "../overridable";

/** For points whose SDK props are empty: a plugin sees nothing and `Original` takes no changes. */
export function noProps<CoreProps extends object>(): PointAdapter<
  CoreProps,
  Record<string, never>
> {
  return { toPlugin: () => ({}), merge: (core) => core };
}

/**
 * An adapter whose `merge` copies the patch's keys onto the core props, for points where every SDK
 * prop keeps its core name. Points that rename or reshape props write their own `merge`.
 */
export function sameNameAdapter<CoreProps extends object, PluginProps extends object>(
  toPlugin: (core: CoreProps) => PluginProps,
): PointAdapter<CoreProps, PluginProps> {
  return {
    toPlugin,
    merge: (core, patch) => ({ ...core, ...patch }),
  };
}
