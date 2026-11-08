# Changelog

[Upstream release history and contributor credits](https://github.com/1ikeadragon/pimi/blob/9eb9f9e9fe879845e4c398b066ef03a60ecc74d9/CHANGELOG.md#0153---2026-11-06)

## 0.17.1 - 2026-11-08

- An explicit daemon home takes precedence over environment defaults when starting the daemon.

[Download Pimi for Android](https://1ikeadragon.github.io/pimi/)

## 0.17.0 - 2026-11-08

- Pimi ships its own daemon, `pimi` command, plugin SDK, and agent skills in the desktop installers.
- Remote QR pairing requires an explicitly configured relay. Pimi Relay is available to self-host.
- Task and review cards put their Open action on the right.

[Download Pimi for Android](https://1ikeadragon.github.io/pimi/)

## 0.16.10 - 2026-11-08

- Remote pairing is opt-in, uses a native pairing link, and requires replay-protected encryption by default.
- Android scans QR codes offline and ships without the Google scanner, Firebase, or Expo development modules.
- Remote Markdown images appear as links. Spaces previews, voice model downloads, and provider quota checks start on request.
- Isolated file previews from external navigation, disabled optional telemetry for managed providers, and verified native syntax grammar archives before compiling them.

## 0.16.9 - 2026-11-08

- Tasks, Work, and Review show unread activity in the sidebar. Opening a view clears its own dot.

## 0.16.8 - 2026-11-08

- Ask Pimi can run available Command Center actions, start a chat with a saved Spaces card, and open named worktree diffs, tasks, pull requests, or session usage.
- Spaces resolves saved arXiv papers by title. Voice requests to remove a card open the existing confirmation.
- Review has a Mine filter for your open GitHub pull requests.

## 0.16.7 - 2026-11-08

- Ask Pimi opens common views directly and uses your configured provider to handle other commands, including saving Spaces cards and creating or moving tasks.
- Agents can create and apply shared labels. The sidebar marks new task activity, and task cards recognize OMP tool results.
- Fixed Agent Grid on Android and restored workspace names in Android Work.

## 0.16.6 - 2026-11-08

### Added

- Pair Pimi for Android with your host to chat, browse work and diffs, tile agents, and check usage.
- Open, create, and move desktop tasks from Android over a password-protected encrypted relay connection.

## 0.16.5 - 2026-11-08

### Added

- Search Spaces by meaning or keyword on your host. Say “search Spaces for…” to draft a chat that can find and reuse cards.
- Open arXiv papers inside Spaces, preview GitHub repository links, and see a confirmation when you copy a card ID.
- Usage shows recorded compactions and Claude Code's token categories after you run `/context`.
- Wide desktop windows fit six live chats in Agent Grid.

### Improved

- Pimi's desktop support links point to Pimi. Removed unused upstream website and publishing tooling from the source tree.

## 0.16.4 - 2026-11-08

### Added

- Usage Recap shows completed tasks and linked pull requests merged this week or last week. Open any entry in Tasks or Review.
- Spaces loads public X posts and YouTube previews when their cards enter view. Press Play to start the video.

## 0.16.3 - 2026-11-08

### Added

- Open linked tasks and pull requests from Work, Tasks, and Review.
- Automatically move a task to Done after all linked worktrees have verified merges while Pimi is connected. Click the completion notification to open the task. Manual stages take precedence.

## 0.16.2 - 2026-11-08

### Added

- Pimi checks its own GitHub releases and verifies installer digests before an update. On macOS, choose Install and restart. On Windows, Pimi can apply a downloaded update when it quits.
- Install and update bundled skills from Library. Hooks shows the installed status of Claude Code, Codex, and OpenCode terminal hooks and lets you install, repair, or remove them.
- Show or hide the Pimi voice command button from Chat settings.

### Improved

- Reorganized Settings around Pimi, the selected host, and system preferences. About links to Pimi’s releases and repository.

## 0.16.1 - 2026-11-08

### Improved

- Grouped the sidebar around Tasks, Work, Review, Activity, Library, and Projects. Memory and Spaces stay visible.
- Moved New workspace and Add project beside Projects. New workspace opens the project chooser even when a project is active.
- Simplified the sidebar footer and put Hosts beside Settings.

## 0.16.0 - 2026-11-08

### Added

- Track tasks straight from chat or delegate them to agents in separate worktrees. The board follows their progress, and linked tasks, worktrees, and chats share labels.
- Watch parallel chats in Agent Grid and fork a conversation to a different provider.
- Review GitHub pull requests, browse files, compare worktree diffs side by side, and step through a file tour.
- Share notes across providers with Memory. Save links, images, and scratch notes in Spaces and give agents the card ID.
- Schedule PR reviews and project digests in Automations. Check harness updates and see session context usage.
- Added DeepSeek Harness support and a voice command bubble with in-app feedback.

### Improved

- Streamlined workspace creation, refreshed the desktop sidebar, and blended the macOS title bar into the workspace.
- Added automatic desktop releases for Apple silicon and Windows x64 with SHA-256 checksums.
