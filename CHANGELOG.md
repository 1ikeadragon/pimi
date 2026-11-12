# Changelog

[Upstream release history and contributor credits](https://github.com/1ikeadragon/pimi/blob/9eb9f9e9fe879845e4c398b066ef03a60ecc74d9/CHANGELOG.md#0153---2026-11-06)

## 0.17.24 - 2026-11-12

- New Attack mode, next to Agent and IDE. Point a lead agent and its helpers at an app you built, and they test it for bugs and security issues without asking for approval and without changing anything.
  - Every agent in the run appears as a tile with a live preview. Click a tile to read it at full width.
  - A run bar shows the target, time and token budgets, Pause and Stop.
  - Findings arrive live, sorted by severity, with repro steps and evidence. Triage them, or send one to a Fix it agent.
  - Agents check new findings against existing ones and merge duplicates.
  - Browser tabs are limited to localhost and one host you name. The agents' shell is not sandboxed, and the launch form says so.
- Images from subagents (opencode, Codex, Pi) show in the subagent panel again.
- The working indicator uses the Ask Pimi mascot.
- Self-hosted relay: Pimi's relay can run on your own server (docs/self-hosted-relay.md). The default relay endpoint is relay.stateless.computer:443, and relay stays off until you turn it on.
- Opening a `pimi://pair` link goes straight to the Connect sheet.
- Reconnecting the app no longer reruns every git command for each workspace: about 650 git launches in 5 minutes of reloads drop to about 70. Repeated launches in the network log collapse into one line with a count, and the log size cap is enforced as it is written.

## 0.17.23 - 2026-11-12

- Images from agents appear right in the chat: screenshots they read, images from MCP tools, and generated images. Several images from one tool call form a grid. Clicking one opens a lightbox with previous and next. Images stay after a restart and a reload, and a missing file shows as unavailable.
- Sent messages keep their attachment pills after a reload, a reconnect, and on your other devices.
- The Network tab logs inbound HTTP and WebSocket connections and process launches. Logs are saved to rotating files in the logs folder, kept for 3 days by default. Passwords in URLs and flag values are masked. An Open logs folder action opens them.
- Leaner agent setup: providers that receive every tool schema each turn now get only the core Pimi tools, and the rest load on demand. Shorter delegation and visualization instructions. The visual formats live in the pimi-visualize skill.
- The daemon no longer serves the browser web app and PWA. Use the desktop or Android app.
- The daemon starts even if your config still has the old `features.webUi` key.

## 0.17.22 - 2026-11-12

- Browser Annotate: each pill in the composer shows your note, and clicking it previews the screenshot, the note and the exact text the agent receives. Attaching right after picking an element keeps the screenshot, and the captured parent chain no longer includes Pimi's own selection class.
- Toasts have a close button.
- Go to Definition and Find References see edits to every open file, not only the one you query. Rename checks every file before writing any of them.
- Git blame on very large files stops retrying after a timeout, so moving the cursor no longer restarts it.
- Switching a chat's voice works even when its older history can't be loaded. Very large Claude chats keep loading from the newest turns instead of replaying the whole history.

## 0.17.21 - 2026-11-12

- Large chats open much faster. Claude and Codex chats load from the newest turns and fetch older history as you scroll. A 291 MB Claude chat now opens in about a quarter of a second. Older history no longer drops rows while paging.
- Long tool output shows a short preview and loads in full when you expand it, hover it, or it is part of the newest turn. If loading fails, the row offers Retry.
- The Git panel shows status without waiting for GitHub, and Spaces show a still preview of embeds until you click to play.
- The editor has a right-click menu with Go to Definition, Find References, Rename and Search Codebase. TypeScript and JavaScript use the built-in TypeScript service. Rust, Python, PHP and Go use rust-analyzer, basedpyright or pyright or pylsp, Intelephense or phpactor, and gopls when they are installed. Pimi never downloads a language server. Without one, navigation matches by name and Rename is off.
- A new Settings → Editor page shows which language server Pimi found for each language and lets you point it at your own. The first time you open a file whose language has no server, Pimi says so once and links to the setting.
- Git blame for the current line appears almost instantly and no longer blanks while you move the cursor.
- A new Pimi models settings page, after Providers, picks the provider, model and thinking level Pimi uses for its own work: chat titles, workspace and branch names, commit messages, pull request text, Describe it and Ask Pimi. Each feature can use the default or its own model. If a chosen model can't run, Pimi shows an error instead of quietly using another one.
- While an agent works, the chat shows Pimi and a status line saying what is happening: the tool it is running, Thinking, Writing, or Waiting for your approval. Elapsed time appears after a few seconds.
- The automation editor no longer asks to discard changes. Unsaved edits stay with each automation while you move around the app, with an Unsaved changes bar to save or discard them. Adding a step or check no longer resets the canvas view. On phones the create buttons wrap.
- Review comments use a compact inline box (⌘↵ to submit), and the floating Send feedback button is gone. Sent annotation pills jump back to their source.

## 0.17.20 - 2026-11-12

- Automations open in a full-screen editor built around the step graph, replacing the old dialog. Drag the canvas to pan, scroll or pinch to zoom, and use Fit to recenter. The graph opens centered at a readable size.
- Checks read as a sentence: "Go to Yes when [reply from a step] [starts with] [text]". Pick a preset from Start from, try a sample reply in Try it, and use the new "starts with" and "ends with" tests. A check that compares with empty text can't be saved.
- Describe it drafts in the background. Keep working, and a notification says when the draft is ready to open. A failed draft offers Retry, and a draft still in progress can be dismissed.
- Unsaved edits in the automation editor survive a dropped connection, and leaving with unsaved edits asks first.
- While agents run and the Mac is on AC power, Pimi keeps the display awake.

## 0.17.19 - 2026-11-11

- Automations can run several steps. Connect agent steps and checks into a graph on the automation's canvas. Steps that don't depend on each other run at the same time, and a later step can use an earlier step's output. A failed run shows which step failed, and Retry reruns from that step, keeping the earlier results.
- Describe an automation in plain words and Pimi drafts the steps and schedule for you to review and edit before saving. A drafted automation waits for your approval, as one an agent creates does.
- Automations can start on pull requests: when a PR opens, gets new commits, or has a review requested. Pimi checks with the `gh` CLI, and each new PR commit starts one run.
- Agents and the CLI can edit an automation's steps and retry a failed run.
- Flow diagrams have a new look. Each box has a coloured icon tile for its kind, edges are dashed and move on desktop, and edge labels are small rounded pills. Hover or tap a box to highlight it and its connections.
- Tapping a chart or diagram on a touch screen now selects it.
- The Android app no longer crashes when you open a chat with a flow diagram.

## 0.17.18 - 2026-11-11

- Automations replace schedules. Run an agent on a cron schedule or at an interval, in the provider's unattended mode. A run that hits a permission prompt fails at once instead of hanging. Automations an agent creates wait until you approve them. **Upgrading deletes the old `schedules` folder in your Pimi home, so recreate any schedules you still need as automations.**
- Heartbeats are separate from automations. You can change or delete them from the CLI.
- Agent profiles: save instructions, a provider, a model and a thinking level as a profile, manage profiles on the new Profiles page, and run automations as a profile. The four built-in profiles are rewritten. ACP agents now receive profile instructions.
- Stop a chat and its working subagents stop with it. The chat shows "Stopped with N subagents · Resume", and Resume restarts them where they left off.
- When one agent answers another agent's permission prompt, the chat shows which agent allowed or denied it.
- Open any chat visual in its own tab: charts, flows, sequence diagrams, tables and Mermaid diagrams, as well as HTML visuals. Pan and zoom charts, flows and tables with a drag, the scroll wheel, a pinch, or the −, + and Fit buttons.
- Sequence and state diagrams are drawn natively and wrap long messages on a phone. Sequence diagrams and flow box borders are readable in light and dark themes, and flow arrowheads land on their boxes.
- Charts with log-scale bars, and heatmaps whose transform is written inside their data, now draw. Mermaid gantt charts are wide enough to read and scroll sideways on a phone. Tables, charts and flows fit a phone screen.
- Subagents use one set of status words everywhere, and the sidebar shows only live subagents under their chat.
- Hub is removed.
- Supply chain: release builds check npm signatures and lockfile sources, refuse packages younger than 10 days, and check packages against a malware feed. npm install scripts are off. Several small dependencies are replaced with built-in Node APIs or local helpers.
- Pimi now ships for macOS on Apple silicon and Windows x64 only, plus Android. Linux and Windows arm64 builds are dropped.

## 0.17.17 - 2026-11-11

- Pimi tools are on unless you turn them off, so agents can start Claude, Codex, and other providers as worker cards, use shared memory, and track tasks. When the tools are off, agents say so instead of running other agent CLIs in a shell.
- Ask an agent to use several providers, such as "use codex and claude for this", and it starts one worker per provider. Name a provider alone and the worker uses that provider's default model and mode.
- Workers appear in the sidebar under the chat that started them, with their provider and status.
- HTML visuals opened in a tab use the app theme, as they do in chat.
- A chart or dashboard with a field Pimi does not know still draws, and a dashboard drops only the tile it cannot read. A block that cannot be drawn shows a short note with its data behind Show data.
- Click an annotation in the composer to jump to the quoted text, which pulses so you can find it. Use the pencil to edit the note.
- Ask Pimi and agents can read the text of links saved in Spaces, including the full text of arXiv papers. For a request that needs more than a short answer, Ask Pimi offers to start a chat.

## 0.17.16 - 2026-11-10

- Select text in chat or code in the editor and click once to annotate it. The note opens under your selection: press Enter to save it, or Escape to drop it.
- Hover an annotation chip in the composer to read the quote and note. Click it to edit.
- Agents choose between a sentence, a chart, a dashboard, a diagram, and an HTML visual with a new visualization skill, and put the finding in the chart title.
- Agents in chats check their results against the code or data before they report them, and say what they did not verify.

## 0.17.15 - 2026-11-10

- Switch a chat to another provider from the model picker and stay in the same chat. The new provider continues with the conversation, and the thread marks where the model changed.
- Charts in chat show a crosshair and the values for the point under the pointer. Click a legend entry to hide a series.
- Agents can show dashboards in chat with metrics, sparklines, sortable tables, and progress, and can draw scatter plots and stacked bars.
- HTML visuals run in the chat when you scroll to them, follow the app theme, and fit their content.
- Delegated agents show as one row with a status dot. Click the row to open the agent.

## 0.17.14 - 2026-11-10

- Press Up and Down in the composer to walk through every message you sent in a chat, including multi-line ones.
- Copilot, Cursor, Kimi, Kiro, Trae, and custom ACP agents now learn Pimi's chart format and chat actions.
- Ask Pimi hears quiet speech, keeps what you said when you press Stop early, and shows your words and its reply as message bubbles with a short sound.
- Preview custom HTML visuals inside a chat or open them in a tab.
- After an app update, an idle background daemon moves to the new version by itself. If agents are working, Pimi offers a restart instead of interrupting them.
- Review suggestions and task proposals are labeled in the chat timeline.

## 0.17.13 - 2026-11-10

- Delegate from a chat and open each worker from its provider card. Start a subagent from the chat’s Subagents menu to keep it under that chat.
- Create and edit provider profiles with their own binaries, arguments, environment variables, and harness settings.
- See reported token and cost breakdowns and inspect recent usage over time.
- Inspect values in bar, line, area, pie, and donut charts with a pointer, keyboard, or touch.
- Search text from supported Spaces link previews. Annotation notes open beside the text or code you selected.

## 0.17.12 - 2026-11-10

- Select text in chat or code in the editor and add a note to your next message.
- Restore in-app updates on Apple silicon.

## 0.17.11 - 2026-11-10

- Restore in-app updates on Apple silicon.

## 0.17.10 - 2026-11-10

- Switch providers from chat and pick up where you left off. Unsent handoffs keep their history after a restart.
- Send work to several providers from one chat. Worker cards show each provider and its status. Tasks can use a different model for each worker.
- Bar and line charts follow your theme and animate as data changes. Reduced motion skips the animation.
- Ask Pimi can search Spaces, check unfinished work, and open the view you ask for. Voice history keeps the transcript and result together.
- Add a custom provider and see provider icons more clearly in Usage.

## 0.17.9 - 2026-11-10

- Open the selected project in IDE mode before starting a chat.

## 0.17.8 - 2026-11-09

- Switch projects or add a local folder from the IDE title bar. Explorer, editor tabs, and chat line up in a single row with softer dividers.
- Search worktree code from Command Center and jump straight to the matching line. Agents can search the same local index.
- Review history restores the pull request, selected file, and diff position. Back from Review returns to your IDE without a stop on an unrelated view.

## 0.17.7 - 2026-11-09

- Switch between Agent Mode and IDE Mode from the desktop title bar. Edit files with Explorer and chat beside your code.
- Open a file’s split or unified diff in the editor and see Git blame for the current line.
- Switching modes keeps your tabs, chat drafts, and recent editor undo history. Save pending edits before switching.
- Added two default skills for narrowing a request and verifying the real app flow before shipping.

## 0.17.6 - 2026-11-09

- Review opens to a pull request inbox. Filter by review requests or your own open PRs, then switch between the PR overview and its diff. Worktree review has its own tab.
- Ask Pimi can inspect work and track tasks in the background. Say you want a new chat when you want one to open.
- Pair a phone with Pimi from Settings on the same Wi-Fi.
- Find orchestration skills and terminal hooks in host settings.

## 0.17.5 - 2026-11-09

- Drag workspaces within a sidebar project to set their order.
- Keep task cards clickable while the board updates.
- Show the Work unread dot when a checkout appears, disappears, or moves to another lane.

## 0.17.4 - 2026-11-09

- Added Ayu Light, One Dark Pro, Nord, Gruvbox Dark, and Catppuccin Mocha to Appearance.

## 0.17.3 - 2026-11-09

- Updated Electron, the HTTP request parser, and other dependencies with security fixes.
- Removed an obsolete web deploy command and updated standalone example dependencies.

## 0.17.2 - 2026-11-09

- Desktop views share the same title bar. Use Back and Forward to return to a view you just visited.
- Hover over Usage to see provider limits. Open it to see limits first, then active sessions and Recap.
- Chats and workspaces get automatic names by default. You can turn this off in Settings, and Pimi keeps names you edit.
- Added Sakura Glass and Cel Night appearances.

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
