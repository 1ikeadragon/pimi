# Pimi development notes

See the [main README](../README.md) for the demo, features, and macOS build.

## Development

Run `npm run build:server` and then `npm run pimi:desktop`. Use the sidebar or **File → Show Pimi Workspace** to switch layouts in the current window. The packaged app uses the normal Paseo daemon home and settings. Set `PIMI_HOME` and `PIMI_LISTEN` before launching the executable to use a separate daemon and state directory.

## Desktop releases

Set the root version, run `npm run version:sync-internal`, and refresh the lockfile with `npm install --package-lock-only --ignore-scripts`. Add a matching section to the changelog for release highlights.

Push the version commit to `main`, then push its `pimi-vX.Y.Z` tag. The release workflow builds both installers, publishes checksums, and adds a commit list for subsequent releases. Push one release tag at a time. If a run fails transiently, rerun all jobs so the publisher gets every artifact from the same attempt. For a code fix, ship a new version.

## Tasks

- The board derives the automatic task stage from its work items. Managed work is ready for review when its agent report arrives; linked checkouts use Git and agent activity. Manual stage overrides persist in the task record. Done closes a task; moving it out of Done reopens it.
- Tasks, linked worktrees, and their chats show shared labels. A label stays editable where it was assigned. Manage the catalog from a workspace’s Labels menu. Pimi picks up catalog renames and removals while connected. If you rename a label while Pimi is closed, update its task assignments when you reopen it.
- Chat is the default worker workspace. Agents can write artifacts in their own folders and optionally reference an attached repository. Choose Git worktree when agents should edit a repository from its pinned commit.
- **Suggest 2 drafts** sends the brief to the selected provider and saves the suggestions for review. **Start agents** makes a short model check without the brief, then starts up to four drafts in parallel. Each draft keeps its launch identity for retries.
- **Dictate brief** opens a small control at the bottom of Tasks and uses Agent Console’s existing dictation flow and configured speech provider. Insert puts editable text in the brief; closing the draft or leaving Tasks cancels the recording.
- A managed work item’s report comes from its finished agent. Pimi collects it automatically as agent status changes. If retrieval fails, **Retry report** fetches the agent’s result again. Closing a task leaves its worktrees available for review.
- Workers from a chat proposal appear as branches under the originating chat. Paseo delivers their completion and final responses to that chat, while Tasks keeps a copy of each report. Open a branch to continue directly with that worker.
- The desktop saves task records in its local app data. With Agent tools enabled, interactive chats on the local daemon can find and update saved tasks, attach repositories from Work, link existing worktrees, and assign existing Paseo labels while the desktop app runs. These tools use the same task store as the board. For the standalone server, set `PIMI_TASK_STATE` to an absolute JSON file path to persist records across restarts.

## Review behavior

- Work shows checkouts associated with active workspaces and tasks. **Watch repository** includes its other available checkouts. Tasks and Work update from daemon events and periodic local Git checks while open. Live updates leave any loaded diff in place. Use **Refresh diff** to load it again. Use Agent Console to import a supported session started elsewhere.
- Working comparisons include new files and tracked changes. GitHub PR reviews pin the base and head returned by GitHub and may fetch their commit objects. Sign in to `gh` to review private PRs.
- **Compare worktrees** loads a second checkout with its own comparison settings. **Find in open diffs** searches the currently displayed patches and source panes. The main review’s editor selector uses the same target discovery and launcher as Agent Console.
- Explain Changes sends tracked diff text to the selected provider when you click it. It uses the first model configured in metadata generation settings, then the latest available agent on the worktree, then a ready provider and its default model. Explanations accept up to 24 KB of diff context. Files without added lines are available in File Tour. File Tour and comparisons work independently of provider availability.
- Local previews use running workspace services. Pimi’s review surface listens on loopback. The agent console uses the daemon’s host and provider settings.

## Source audit

A read-only audit at upstream commit `9f68af0274ca06c5decd6269d870d442b8e04500` sampled daemon and relay startup, desktop IPC, plugin and updater paths, and the npm lockfile, patches, and CI configuration. A follow-up sampled Pimi's review server, Git and editor handling, and walkthrough provider requests. The inspected paths showed no apparent backdoor. Older daemon homes can enable relay through compatibility behavior, the desktop renderer has access to privileged IPC, and enabled third-party plugins run with daemon-user access. Dependency internals and released binaries were outside the audit scope.
