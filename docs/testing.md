# Testing

Pimi has no automated test suite, and you do not write unit tests. You verify a change by running the real product flow with real inputs, on every platform the change affects. [qa.md](qa.md) sets the evidence bar for a pull request.

## Verify in the real app

Start the checkout-local stack, never the main daemon on port 6767:

```bash
npm run dev                  # dev daemon on 127.0.0.1:6768, state in .dev/paseo-home
npm run dev:desktop          # Electron desktop against the dev daemon
npm run dev:app              # Expo app against the dev daemon
npm run cli -- ls -a -g      # CLI against the dev daemon
```

Then walk the flow the way a person would. [pimi-walk-the-flow](../skills/pimi-walk-the-flow/SKILL.md) is the checklist: ship-path input, check the thing that should actually change, try the likeliest interruption, and say which steps used fixture data.

- Use real inputs: a real repository, a real provider, a real file. A fixture proves the fixture parses.
- Cover every platform the change affects. [qa.md](qa.md) has the platform table.
- Agent provider work needs a run against the real provider by someone who can tell that it worked. If provider auth fails, report it.
- When something misbehaves, add temporary logging, run the flow again, and read the daemon log at `$PASEO_HOME/daemon.log`. Remove the logging when you are done.

## Always run

```bash
npm run typecheck
npm run lint
```

[CLAUDE.md](../CLAUDE.md) lists the build-order gotcha for cross-package type errors.

## Fallible user actions

Every user action that can fail must expose the complete operation state in the UI:

- **Pending:** show immediate progress and prevent accidental duplicate submissions.
- **Success:** show the requested result, or a clear success acknowledgement when the result is not otherwise visible.
- **Failure:** keep an actionable error visible in the same context until the user retries or dismisses it.

Logs, console output, and a reset button are not user feedback. Neither is a platform API unless it is verified on every supported platform: React Native Web's `Alert.alert()` is a no-op, so browser and Electron failures must use rendered app UI such as the shared alert component.

When you verify one of these actions, trigger the failure for real (stop the daemon, send a bad input) and check what the user can see and do afterward. Timeout and disconnect failures can recover differently, so try both.

## Packaged-app smoke

The one automated check is the packaged-app smoke, `packages/desktop/scripts/packaged-app-smoke.js`. It launches the packaged desktop app on macOS or Windows with isolated user data and daemon state, connects to the real renderer over the Chromium debugging protocol, and fails unless the renderer mounts with the desktop bridge, the renderer starts its own desktop-managed daemon, every built-in plugin starts, and the bundled CLI can cold-start a daemon, query it, and run a terminal command. It observes the production launch path and adds no smoke-only branch to Electron main.

It runs only when `PASEO_DESKTOP_SMOKE=1` is set. `scripts/after-pack.js` and `scripts/after-sign.js` gate on that variable, so the smoke runs during packaging:

```bash
PASEO_DESKTOP_SMOKE=1 \
PASEO_DESKTOP_SMOKE_ARTIFACT_DIR=/tmp/pimi-desktop-smoke \
npm run pimi:package:mac
```

The artifact directory receives the renderer screenshot and the desktop and daemon logs. The smoke also catches the failure that every dev run misses: a package imported at runtime that is only a `peerDependency`. electron-builder packs declared production `dependencies` only, so the import resolves in the hoisted workspace and throws `ERR_MODULE_NOT_FOUND` inside `app.asar`.

A passing smoke does not replace walking the flow in the packaged app when your change touches packaging, startup, or the CLI shim.

## Browser capture harness

For changes to the desktop browser pane, [browser-capture-harness.md](browser-capture-harness.md) describes the real-Electron check you run by hand.
