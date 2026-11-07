# Pimi development notes

See the [main README](../README.md) for the demo, features, and macOS build.

## Development

Run `npm run build:server` and then `npm run pimi:desktop`. Use **File → Show Pimi Workspace** to return from Agent Console. The packaged app uses the normal Paseo daemon home and settings. Set `PASEO_HOME` and `PASEO_LISTEN` before launching the executable to use a separate daemon and state directory.

## Tasks

- A task pins the selected repository’s current commit when created. Experiments can link existing worktrees from that repository or create separate managed worktrees at the pinned commit.
- **Suggest 2 drafts** sends the brief to the selected provider and saves the suggestions for review. **Run experiments** makes a short model check without the brief, then starts up to four draft experiments in parallel through the daemon. Each draft keeps its launch identity for retries.
- **Dictate brief** uses Agent Console’s existing dictation controls and configured speech provider. The transcribed text goes into the brief for editing before you save.
- Finished workers’ reports are collected while their task is open. Reports can also be added or collected manually. Closing a task leaves the linked worktrees available for review.
- Use **Open chat** from an experiment or its review to continue a conversation in the original agent session.
- The desktop saves task records in its local app data. For the standalone server, set `PIMI_TASK_STATE` to an absolute JSON file path to persist them across restarts.

## Review behavior

- The board follows active sessions known to the connected local daemon. Use Agent Console to import a supported session started elsewhere.
- Working comparisons show tracked changes and report untracked files separately. GitHub PR reviews pin the base and head returned by GitHub and may fetch their commit objects. Sign in to `gh` to review private PRs.
- Explain Changes sends tracked diff text to the selected provider when you click it. It uses the first model configured in metadata generation settings, then the latest available agent on the worktree, then a ready provider and its default model. Explanations accept up to 24 KB of diff context. Files without added lines are available in File Tour. File Tour and comparisons work independently of provider availability.
- Local previews use running workspace services. Pimi’s review surface listens on loopback. The agent console uses the daemon’s host and provider settings.

## Source audit

A read-only audit at upstream commit `9f68af0274ca06c5decd6269d870d442b8e04500` sampled daemon and relay startup, desktop IPC, plugin and updater paths, and the npm lockfile, patches, and CI configuration. A follow-up sampled Pimi's review server, Git and editor handling, and walkthrough provider requests. The inspected paths showed no apparent backdoor. Older daemon homes can enable relay through compatibility behavior, the desktop renderer has access to privileged IPC, and enabled third-party plugins run with daemon-user access. Dependency internals and released binaries were outside the audit scope.
