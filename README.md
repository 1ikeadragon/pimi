# Pimi

Start with a coding question, explore approaches in parallel, and review the evidence in one macOS app. Pimi brings tasks, Git worktrees, agents, and code review together.

[![Watch Pimi go from a dictated brief to parallel worktrees, reports, and code review](assets/pimi/tasks.jpg)](assets/pimi/demo.mp4)

[Watch the full workflow](assets/pimi/demo.mp4). The recording uses scripted model and speech fixtures with real Pimi workspace creation, Git changes, and review.

## Start in chat

Pimi opens in Agent Console. On first launch, setup helps you connect a provider, add a project, and start a conversation.

![The first Pimi window with setup, provider and project steps, and examples for chat and Tasks](assets/pimi/onboarding.jpg)

With **Agent tools** enabled, an agent can suggest a task when you describe work worth tracking or ask to compare approaches. **Review task draft** opens an editable brief with the suggested experiments. Save it when you're ready, then launch experiments separately. **Original chat** takes you back to the conversation.

![The full Agent Console with a task proposal based on a conversation about two worktree experiments](assets/pimi/task-handoff.jpg)

![The full Tasks window with the editable brief and two selectable experiments before saving](assets/pimi/task-draft.jpg)

## Follow a research task

The example compares two ways to reduce repeated metadata lookups. Each experiment has its own agent and Git worktree.

### 1. Capture the question

Create a task with a title and brief. Dictate into the brief, then edit the transcript before saving.

![The full task creation window with the dictation sheet open](assets/pimi/dictation.jpg)

### 2. Choose what to try

Write your own experiments or ask your configured model to suggest two. Run the drafts you want to explore.

![The task with two proposed experiments and the controls to launch them](assets/pimi/drafts.jpg)

### 3. Follow the worktrees

Auto-Kanban follows Git and agent activity. Return to the task to compare reports as the workers finish.

![The full Auto-Kanban board with worktrees in parallel](assets/pimi/board.jpg)

### 4. Ask a follow-up

Open the original worker’s conversation from its report. The console sidebar returns to Tasks or Worktrees, and **Review changes** opens the chat’s checkout directly.

![The full Agent Console showing a follow-up, its answer, and links back to the workspace](assets/pimi/chat.jpg)

### 5. Read the diff

Review one file at a time or split the view explicitly. **Explain changes** adds notes anchored to changed lines, alongside the diff.

![The full review workspace with a changed line and its explanation](assets/pimi/review.jpg)

### Choose an appearance

The same task in Paper and Dark. Blush adds fine grain to the surrounding chrome. The appearance applies to Agent Console and dictation, too.

![The completed task and experiment reports in Paper](assets/pimi/paper.jpg)

![The same task and experiment reports in Dark](assets/pimi/dark.jpg)

## What you can do

- **Start with a task.** Type or dictate a brief using the same voice input as Agent Console. Draft ideas yourself or ask your configured model to suggest two, then link existing checkouts or start a fresh worktree and agent for each experiment.
- **Compare findings.** Read the workers’ reports together, continue chatting in their original sessions, and open their diffs against the task’s pinned base. Close the task when you’re finished.
- **See what needs you next.** Auto-Kanban sorts worktrees into **Ready**, **In progress**, **Review**, and **Needs attention** from Git and live agent activity. Search by repo, branch, or agent. Pimi remembers repositories you add.
- **Review code in place.** Open **Review** and pick a worktree, or jump there from chat. Compare working changes, a branch against a base ref, or a GitHub pull request. Open two files side by side and switch between diffs and syntax-highlighted source. Search changed paths and reload a comparison while keeping files that are still in the diff.
- **Follow changes line by line.** File Tour walks through the changed files. Explain Changes uses your configured provider to generate short notes tied to added lines. Notes stay below the diff so you can read both together.
- **Preview and edit.** Open a healthy workspace service from its review. Jump from a reviewed line to the corresponding file in Zed when the local checkout matches.
- **Manage agents.** Open Agent Console for sessions, terminals, workspace services, voice, and provider settings.
- **Choose an appearance.** Follow macOS automatically or switch between Blush, Dark, and Paper. The workspace, Agent Console, and dictation share the same setting.

Press `/` to focus the search field for the current view. In review, use `[` and `]` to move through files or through an open tour.

## Run on macOS

Build from source on Apple silicon with Git and the Node version in [`.tool-versions`](.tool-versions). GitHub CLI handles pull request lookup, and Zed is optional for opening files in an editor.

```sh
npm ci
npm run pimi:package:mac
open packages/desktop/release-pimi/mac-arm64/Pimi.app
```

The build creates a local, non-notarized app bundle. Follow setup to start a chat, or open **Tasks** directly from the sidebar. A brief can be saved before you attach a repository. In **Worktrees**, choose **Add repository…** to add an existing Git checkout.

[Development commands, provider selection, and audit notes](pimi/README.md)

## Credits

- **Paseo**, by Mohamed Boudra and contributors, is Pimi’s upstream. Pimi inherits its agent runtime, SDK, desktop shell, syntax highlighter, and editor launcher. [Upstream source](https://github.com/getpaseo/paseo)
- **Electron** provides the desktop runtime. [Electron source](https://github.com/electron/electron)
- **Git** provides worktrees and comparisons. **GitHub CLI** supplies pull request metadata and authentication. [Git source](https://github.com/git/git) · [GitHub CLI source](https://github.com/cli/cli)
- **Zed** is the optional editor for opening a reviewed file at its line. [Zed source](https://github.com/zed-industries/zed)

Pimi retains Paseo’s copyright and Apache 2.0 license. Third-party components retain their own licenses. [License](LICENSE)
