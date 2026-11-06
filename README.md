# Pimi

Track parallel coding agents and review their work without juggling checkouts. Pimi brings your Git worktrees, agent status, local previews, and code review into one macOS app.

[![Watch the Pimi demo showing the worktree board, side-by-side review, and a text walkthrough](assets/pimi/review.jpg)](assets/pimi/demo.mp4)

[Watch the demo](assets/pimi/demo.mp4) · [View the worktree board](assets/pimi/board.jpg)

## What you can do

- **See what needs you next.** Auto-Kanban sorts worktrees into **Ready**, **In progress**, **Review**, and **Needs attention** from Git and live agent activity. Search by repo, branch, or agent. Pimi remembers repositories you add.
- **Review code in place.** Compare working changes, a branch against a base ref, or a GitHub pull request. Open two files side by side and switch between diffs and syntax-highlighted source. Search changed paths and reload a comparison while keeping files that are still in the diff.
- **Follow changes line by line.** File Tour walks through the changed files. Explain Changes uses your configured provider to generate short notes tied to added lines. The tour stays on screen while you read.
- **Preview and edit.** Open a healthy workspace service from its review. Jump from a reviewed line to the corresponding file in Zed when the local checkout matches.
- **Manage agents.** Open Agent Console for sessions, terminals, workspace services, voice, and provider settings.

Press `/` to focus the search field for the current view. In review, use `[` and `]` to move through files or through an open tour.

## Run on macOS

Build from source on Apple silicon with Git and the Node version in [`.tool-versions`](.tool-versions). GitHub CLI handles pull request lookup, and Zed is optional for opening files in an editor.

```sh
npm ci
npm run pimi:package:mac
open packages/desktop/release-pimi/mac-arm64/Pimi.app
```

The build creates a local, non-notarized app bundle. Choose **Watch a repository** and enter a local Git repository path, then open a worktree card. Use **Agent console** to manage sessions and providers.

[Development commands, provider selection, and audit notes](pimi/README.md)

## Credits

- **Paseo**, by Mohamed Boudra and contributors, is Pimi’s upstream. Pimi inherits its agent runtime, SDK, desktop shell, syntax highlighter, and editor launcher. [Upstream source](https://github.com/getpaseo/paseo)
- **Electron** provides the desktop runtime. [Electron source](https://github.com/electron/electron)
- **Git** provides worktrees and comparisons. **GitHub CLI** supplies pull request metadata and authentication. [Git source](https://github.com/git/git) · [GitHub CLI source](https://github.com/cli/cli)
- **Zed** is the optional editor for opening a reviewed file at its line. [Zed source](https://github.com/zed-industries/zed)

Pimi retains Paseo’s copyright and Apache 2.0 license. Third-party components retain their own licenses. [License](LICENSE)
