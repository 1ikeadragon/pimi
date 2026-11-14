# Aurora backdrop plugin example

Two themes with a window backdrop, like Pimi's Day, Dusk, Night, Dawn, and Tide:

- **Aurora** draws a live fragment shader (`client/aurora.frag`).
- **Ember** shows a static image (`client/ember.png`) under a veil (`client/ember-veil.png`).

Both PNGs are small generated gradients. Replace them with your own webp, png, or jpg art.

The plugin is client-only: two `addTheme` calls in `index.client.ts`. See
[Contribute a theme](../../public-docs/plugins/reference.md#contribute-a-theme) for the backdrop
rules, size limits, and the contrast guard.

Register it in `$PIMI_HOME/config.json`:

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "aurora-backdrop": {
      "source": "directory",
      "path": "/absolute/path/to/pimi/plugin-examples/aurora-backdrop"
    }
  }
}
```

Then run `pimi reload` and pick **Aurora** or **Ember** in Settings → Appearance.
