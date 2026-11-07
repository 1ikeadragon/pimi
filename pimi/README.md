# Pimi development notes

See the [main README](../README.md) for the demo, features, and macOS build.

## Development

Run `npm run build:server` and then `npm run pimi:desktop`. Use the sidebar or **File → Show Pimi Workspace** to switch layouts in the current window. The workspace toolbar can move the same view into its own window and back. The packaged app uses the normal Paseo daemon home and settings. Set `PASEO_HOME` and `PASEO_LISTEN` before launching the executable to use a separate daemon and state directory.

## Tasks

- The board derives the automatic task stage from its work items. Managed work is ready for review when its agent report arrives; linked checkouts use Git and agent activity. Manual stage overrides persist in the task record. Done closes a task; moving it out of Done reopens it.
- A task pins each attached repository’s current commit. Work items can link existing checkouts or create managed worktrees at their own repository’s pinned commit.
- **Suggest 2 drafts** sends the brief to the selected provider and saves the suggestions for review. **Start agents** makes a short model check without the brief, then starts up to four drafts in parallel. Each draft keeps its launch identity for retries.
- **Dictate brief** opens a small control at the bottom of Tasks and uses Agent Console’s existing dictation flow and configured speech provider. Insert puts editable text in the brief; closing the draft or leaving Tasks cancels the recording.
- A managed work item’s report comes from its finished agent. Pimi collects it automatically as agent status changes. If retrieval fails, **Retry report** fetches the agent’s result again. Closing a task leaves its worktrees available for review.
- Use **Open chat** from a work item or its review to continue in the original agent session.
- The desktop saves task records in its local app data. For the standalone server, set `PIMI_TASK_STATE` to an absolute JSON file path to persist them across restarts.

## Review behavior

- The board follows active sessions known to the connected local daemon. Visible Tasks and Worktrees reconcile from daemon events and periodic local Git checks. Live updates leave any loaded diff in place; use **Refresh diff** to load it again. Use Agent Console to import a supported session started elsewhere.
- Working comparisons show tracked changes and report untracked files separately. GitHub PR reviews pin the base and head returned by GitHub and may fetch their commit objects. Sign in to `gh` to review private PRs.
- **Compare worktrees** loads a second checkout with its own comparison settings. **Find in open diffs** searches the currently displayed patches and source panes. The main review’s editor selector uses the same target discovery and launcher as Agent Console.
- Explain Changes sends tracked diff text to the selected provider when you click it. It uses the first model configured in metadata generation settings, then the latest available agent on the worktree, then a ready provider and its default model. Explanations accept up to 24 KB of diff context. Files without added lines are available in File Tour. File Tour and comparisons work independently of provider availability.
- Local previews use running workspace services. Pimi’s review surface listens on loopback. The agent console uses the daemon’s host and provider settings.

## Source audit

A read-only audit at upstream commit `9f68af0274ca06c5decd6269d870d442b8e04500` sampled daemon and relay startup, desktop IPC, plugin and updater paths, and the npm lockfile, patches, and CI configuration. A follow-up sampled Pimi's review server, Git and editor handling, and walkthrough provider requests. The inspected paths showed no apparent backdoor. Older daemon homes can enable relay through compatibility behavior, the desktop renderer has access to privileged IPC, and enabled third-party plugins run with daemon-user access. Dependency internals and released binaries were outside the audit scope.
