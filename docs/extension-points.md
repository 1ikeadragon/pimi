# Extension points

How to make a piece of Pimi's UI replaceable by plugins. The point list is the `PluginComponentPoints`, `PluginSlots`, and `PluginMenus` types in `packages/plugin/src/client/extension-points.ts`; this doc does not repeat it. The author side is in the [plugin reference](../public-docs/plugins/reference.md#extension-points).

Core code never imports the plugin loader. `packages/app/src/extension-points/` holds the registry and two entry points: `overridable()` wraps a component, `<Slot/>` renders added UI. The loader (`packages/app/src/plugins/registry.ts`) is the only writer.

## Add a component point

Wrap the component at its definition, not at its call sites, and add the id and props to `PluginComponentPoints` in the same commit:

```tsx
const UserMessageBase = memo(function UserMessage(props: UserMessageProps) {
  /* … */
});

export const UserMessage = overridable("chat.userMessage", UserMessageBase, {
  toPlugin: ({ message, timestamp }) => ({ message, timestamp /* plain data only */ }),
  merge: (core, patch) => ({ ...core, message: patch.message ?? core.message }),
});
```

- **The adapter is the contract.** `toPlugin` maps internal props to the SDK's plain data and callbacks, so a core refactor does not leak into plugins. `merge` maps the partial a plugin hands to `Original` back onto the core props; leave out what a plugin cannot change.
- **Raw access needs no adapter.** `client.unstable.*` reaches every point by id with the internal props, typed `any`. A point with no typed contract takes the two-argument form of `overridable`.
- **Keep the memo.** `overridable` reads `$$typeof` and the comparison of a `memo` core and memoizes its own function with it. Pass the memoized component in; never wrap `overridable(...)` in a second `memo`.
- **Nothing registered costs one function call.** The point subscribes to its own id only, so installing a sidebar override never re-renders chat rows. A point must keep that fast path: no extra wrapper element, context, or state when the snapshot is empty.
- **Points on hot paths** (chat rows, sidebar rows, the composer) need a render-count check before and after, against the same long chat. See [agent-stream-performance.md](agent-stream-performance.md).

## Add a slot

Drop `<Slot id context/>` where plugin UI belongs and add the id and its context to `PluginSlots`. A slot with no items renders `null`. Give `context` a stable reference (a module constant or `useMemo`) so items do not re-render for nothing.

## Behavior to keep

- Each plugin layer sits in `LayerBoundary`. A throw renders the next layer in and records the error for the Plugins page. Do not add a catch inside a point that hides the error.
- One replacement per point, resolved by `(order, plugin id)`; every wrapper applies. Conflicts are listed, never prompted.
- Safe mode makes every snapshot empty. A new point gets it for free; do not read the registry some other way.
- Overrides are app-wide. The loader applies a plugin id once, from its remembered host or the first host by id. A point must not assume the plugin's host is the host of the data it renders.
- `settings.section` passes the page slug from `APP_SETTINGS_PAGES` (`packages/app/src/settings-index/sections.ts`). Pages get merged and removed; an override keyed to a slug that no longer exists (`sidebar`, `terminal`, `browser`, `files`, `integrations`, `notifications`, `permissions`, `diagnostics`) stops matching without an error.

## What is not a point yet

The `workspace-tab` menu (tab context menu items) is not wired, and neither are the terminal, browser pane, and markdown renderer. The `panel` point is one id for every panel kind: `panelPoint` in `workspace-pane-content.tsx` makes one wrapped component per kind and caches it, because a new component per render would remount the panel.
