# Pimi development notes

See the [main README](../README.md) for the demo, features, and macOS build.

## Development

Run `npm run build:server` and then `npm run pimi:desktop`. Use the sidebar to switch layouts in the current window. The packaged app uses the normal Pimi daemon home and settings. Set `PIMI_HOME` and `PIMI_LISTEN` before launching the executable to use a separate daemon and state directory.

## Desktop releases

Set the root version, run `npm run version:sync-internal`, and refresh the lockfile with `npm install --package-lock-only --ignore-scripts`. Add a matching section to the changelog for release highlights.

Push the version commit to `main`, then push its `pimi-vX.Y.Z` tag. The release workflow builds both installers, publishes checksums, and adds a commit list for subsequent releases. Push one release tag at a time. If a run fails transiently, rerun all jobs so the publisher gets every artifact from the same attempt. For a code fix, ship a new version.

## What this page serves

The embedded page (`pimi/public`) shows Memory and Spaces, and hosts the voice dock. Tasks and labels are not here: the daemon owns them and the app renders the Tasks screen (see [data-model.md](../docs/data-model.md#tasks-and-labels)). Desktop imports an old `<userData>/pimi-tasks.json` into the daemon once and renames it `.migrated`.

The page listens on loopback. The agent console uses the daemon’s host and provider settings.

## Source audit

A read-only audit at upstream commit `9f68af0274ca06c5decd6269d870d442b8e04500` sampled daemon and relay startup, desktop IPC, plugin and updater paths, and the npm lockfile, patches, and CI configuration. A follow-up sampled Pimi's former review server, Git and editor handling, and walkthrough provider requests. The inspected paths showed no apparent backdoor. Older daemon homes can enable relay through compatibility behavior, the desktop renderer has access to privileged IPC, and enabled third-party plugins run with daemon-user access. Dependency internals and released binaries were outside the audit scope.
