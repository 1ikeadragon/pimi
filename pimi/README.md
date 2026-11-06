# Pimi

Pimi is a macOS desktop fork of [Paseo](https://github.com/getpaseo/paseo). The worktree board and review desk open in Pimi. **Agent console** opens Paseo's existing interface in a second window for agent sessions, terminals, workspace services, host connections, voice, and settings.

## Use the desktop app

On Apple silicon, build from the repository root with the Node version in `.tool-versions`.

```sh
npm ci
npm run pimi:package:mac
open packages/desktop/release-pimi/mac-arm64/Pimi.app
```

This build produces a local, non-notarized app bundle. For development, run `npm run build:server` followed by `npm run pimi:desktop`. **File → Pimi Worktree Board** opens the review window again. The packaged app uses the normal Paseo daemon home and settings. Set `PASEO_HOME` and `PASEO_LISTEN` before launching the executable to use a separate daemon and state directory.

1. Open an existing Git workspace in Agent Console or select **Watch a repository** and enter its local path. Pimi reads all Git worktrees belonging to that repo. Repositories added from the desktop board are remembered.
2. Choose a card. Agent activity and approval signals update the board alongside local Git state. A **Preview** link appears when Paseo reports a healthy workspace service.
3. Compare the branch against a local base, inspect working changes, or paste a GitHub PR URL. GitHub PRs use the base and head reported by GitHub and may fetch commit objects. Use an authenticated `gh` session for private PRs.
4. Open two files in the review desk. **File** toggles full source with Paseo syntax highlighting. **File tour** steps through the changed files. **Explain changes** requests line-linked notes from your Paseo provider. **Zed** opens the selected local file at its line when the checkout matches.

The provider selection uses the first model in Paseo's metadata generation settings, then the latest available agent on the selected worktree, then a ready provider and its default model. Explanations send tracked diff text to that provider when you click the button. Paseo owns the provider runtime and credentials. The file tour and comparison work independently of provider availability.

## Scope

- The board follows active sessions known to the connected local Paseo daemon. Sessions from external clients can enter that view through Paseo's import flow.
- Working comparisons show tracked changes and report the number of untracked files separately. GitHub PR reviews pin their commit IDs. Large comparisons can exceed the Git output or file display limit. Explanations accept up to 24 KB of diff context, and files without added lines stay in the file tour.
- GitHub PRs are browsable inside Pimi. Hosted review submission and managed cloud preview infrastructure are outside this build. Local previews reuse running Paseo workspace services.
- Pimi's review surface listens on loopback. The upstream agent console retains Paseo's host and provider settings. Use trusted repositories and providers. In particular, Paseo plugins and editor workspaces can execute local code.

## Upstream and research

Pimi preserves Paseo's Git history, copyright, and license. It adds the board and review desk under `pimi/` and uses Paseo's Electron shell, SDK, highlighter, and editor launcher. The private GitHub repo is a standalone copy because [GitHub public forks are public](https://docs.github.com/en/pull-requests/reference/forks#visibility-of-forks).

[LightSprint](https://lightsprint.ai/) informed the worktree → preview → review flow. [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) informed the board, and [CodeTour](https://github.com/microsoft/codetour) informed the ordered, line-linked notes.

A read-only audit at upstream commit `9f68af0274ca06c5decd6269d870d442b8e04500` sampled daemon and relay startup, desktop IPC, plugin and updater paths, and the npm lockfile, patches, and CI configuration. It found no apparent backdoor in those paths. Older daemon homes can enable relay through compatibility behavior, the desktop renderer has access to privileged IPC, and enabled third-party plugins run with daemon-user access. The audit covered neither all dependencies nor released binaries.
