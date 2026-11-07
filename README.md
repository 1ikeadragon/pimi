# Pimi

Start with a coding question, explore approaches in parallel, and review the evidence in one macOS app. Pimi brings tasks, Git worktrees, agents, and code review together.

[![Watch Pimi go from a dictated brief to parallel worktrees, reports, and code review](assets/pimi/tasks.jpg)](assets/pimi/demo.mp4)

[Watch the full workflow](assets/pimi/demo.mp4). The recording uses scripted model and speech fixtures with real Pimi workspace creation, Git changes, and review.

## Inside Pimi

| Auto-Kanban                                                           | In-app code review                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| ![Worktrees grouped by Git and agent activity](assets/pimi/board.jpg) | ![Two changed files and a line-linked File Tour in Pimi](assets/pimi/review.jpg) |

| Paper appearance                                                     | Brief dictation                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ![A task and its reports in Paper appearance](assets/pimi/paper.jpg) | ![Pimi dictation controls for inserting speech into a task brief](assets/pimi/dictation.jpg) |

| Dark appearance                                           | Agent chat                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ![The same task in Dark appearance](assets/pimi/dark.jpg) | ![A follow-up in the experiment's original agent session](assets/pimi/chat.jpg) |

## What you can do

- **Start with a task.** Type or dictate a brief using the same voice input as Agent Console. Draft ideas yourself or ask your configured model to suggest two, then link existing checkouts or start a fresh worktree and agent for each experiment.
- **Compare findings.** Read the workers’ reports together, continue chatting in their original sessions, and open their diffs against the task’s pinned base. Close the task when you’re finished.
- **See what needs you next.** Auto-Kanban sorts worktrees into **Ready**, **In progress**, **Review**, and **Needs attention** from Git and live agent activity. Search by repo, branch, or agent. Pimi remembers repositories you add.
- **Review code in place.** Compare working changes, a branch against a base ref, or a GitHub pull request. Open two files side by side and switch between diffs and syntax-highlighted source. Search changed paths and reload a comparison while keeping files that are still in the diff.
- **Follow changes line by line.** File Tour walks through the changed files. Explain Changes uses your configured provider to generate short notes tied to added lines. Notes stay below the diff so you can read both together.
- **Preview and edit.** Open a healthy workspace service from its review. Jump from a reviewed line to the corresponding file in Zed when the local checkout matches.
- **Manage agents.** Open Agent Console for sessions, terminals, workspace services, voice, and provider settings.
- **Choose an appearance.** Follow macOS automatically or switch between Blush, Dark, and Paper in Tasks, Worktrees, and Review.

Press `/` to focus the search field for the current view. In review, use `[` and `]` to move through files or through an open tour.

## Run on macOS

Build from source on Apple silicon with Git and the Node version in [`.tool-versions`](.tool-versions). GitHub CLI handles pull request lookup, and Zed is optional for opening files in an editor.

```sh
npm ci
npm run pimi:package:mac
open packages/desktop/release-pimi/mac-arm64/Pimi.app
```

The build creates a local, non-notarized app bundle. In **Worktrees**, choose **Add repository…** and enter a local Git repository path. Return to **Tasks** to create a brief. Use **Agent Console** to manage sessions and providers.

[Development commands, provider selection, and audit notes](pimi/README.md)

## Credits

- **Paseo**, by Mohamed Boudra and contributors, is Pimi’s upstream. Pimi inherits its agent runtime, SDK, desktop shell, syntax highlighter, and editor launcher. [Upstream source](https://github.com/getpaseo/paseo)
- **Electron** provides the desktop runtime. [Electron source](https://github.com/electron/electron)
- **Git** provides worktrees and comparisons. **GitHub CLI** supplies pull request metadata and authentication. [Git source](https://github.com/git/git) · [GitHub CLI source](https://github.com/cli/cli)
- **Zed** is the optional editor for opening a reviewed file at its line. [Zed source](https://github.com/zed-industries/zed)

Pimi retains Paseo’s copyright and Apache 2.0 license. Third-party components retain their own licenses. [License](LICENSE)
