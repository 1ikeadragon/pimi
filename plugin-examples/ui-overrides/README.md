# UI overrides plugin example

Changes how Pimi looks without changing Pimi. Three of the app's extension points, one each way:

- `overrideComponent("chat.userMessage", …)` replaces the user's chat messages with a bubble.
- `wrapComponent("sidebar.workspaceRow", …)` keeps each workspace row and adds the branch as a badge.
- `overrideComponent("settings.section", …)` replaces the About page and hands every other page to
  `Original`.

```bash
pimi plugin add /absolute/path/to/pimi/plugin-examples/ui-overrides
```

Open Settings, Plugins, UI Overrides and turn on **Make the message bubble throw**. The bubble fails
while rendering, chat falls back to Pimi's own message, and the Plugins page lists the failure. A
plugin that throws can never take the app down.

If a plugin's UI makes the app hard to use, turn on safe mode on the Plugins page, or open the web or
desktop renderer with `?safe=1`. Pimi then draws its own UI at every point while plugins keep running.

The point ids and their props are the `PluginComponentPoints` type in `@pimi/plugin/client`.
`client.unstable.overrideComponent(id, Component)` reaches any extension point with Pimi's internal
props; those props change between releases.
