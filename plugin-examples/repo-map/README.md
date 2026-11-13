# Repo Map plugin example

A full-screen treemap of a workspace's repository. Each box is a tracked file sized by its bytes and
colored by how recently one of the last 500 commits touched it; folders are labelled outlines. It
shows what a plugin can build on its own, with no changes to Pimi:

- a screen drawn with `react-native-svg`, panned and zoomed with `react-native-gesture-handler`
- a sidebar item, a Command Center item with the `mod+alt+m` shortcut (rebindable in Settings), and
  a **Show in Repo Map** item on file tree rows
- repository data from the daemon through the plugin's own RPC and a subscription that refreshes the
  map when files change
- `server.storage`, which caches commit times by `HEAD`

```bash
pimi plugin add /absolute/path/to/pimi/plugin-examples/repo-map
```

- `shared/contracts.ts` defines the `repo-map.scan` RPC and the `repo-map.watch` subscription.
- `shared/treemap.ts` is the layout: a squarified treemap in about 100 lines, with no dependencies.
- `server/scan.ts` reads `git ls-files` and file sizes, capped at 50,000 files. A larger repository
  returns the first 50,000 with `truncated: true` and the screen says so.
- `client/treemap-view.tsx` draws the boxes. It is memoized, so panning and zooming move a wrapping
  view and never redraw the SVG.
