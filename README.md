# Pimi

<img src="packages/desktop/assets/pimi-icon.png" alt="Pimi app icon" width="88" />

**Your swarm’s best friend.**

Chat with your agents, track their work, and review the changes in one app.

[Download for macOS or Windows](https://1ikeadragon.github.io/pimi/)

## Chat and Tasks

Track something from chat or send agents to explore it in separate worktrees. Queue a follow-up, fork a chat across providers, or click Pimi to give a voice command.

![Chat with a task created from a message](assets/pimi/chat.jpg)

The Tasks board follows linked work and lets you move cards yourself. Open a task to read the agents’ reports.

![Tasks board with stages, labels, and linked work](assets/pimi/task-board.jpg)

## Watch the swarm

Tile agent sessions in **Agent grid**. Use **Work** to see where each worktree stands.

![Agent grid with parallel sessions](assets/pimi/agent-grid.jpg)

## Review together

Compare worktree diffs side by side. Switch to **PRs** for review requests, check results, and pull request details.

![The same source file in two worktree diffs](assets/pimi/review.jpg)

![Pull request queue and check results](assets/pimi/pull-requests.jpg)

<details>
<summary>Setup, Work, Memory, Spaces, Automations, and Usage</summary>

**Setup** gets you from the welcome screen to your first chat.

![Pimi welcome screen](assets/pimi/onboarding.jpg)

**Work** shows which branches are ready to start, in progress, or ready for review.

![Work board with linked worktrees](assets/pimi/board.jpg)

**Memory** keeps project notes available across providers.

![Shared memory notes and their contents](assets/pimi/memory.jpg)

**Spaces** holds links, images, and scratch notes you can hand to an agent by card ID.

![Spaces with scratch notes, a link, and an image](assets/pimi/spaces.jpg)

**Automations** runs repeat jobs like PR review and project digests.

![Automation schedules and templates](assets/pimi/automations.jpg)

**Usage** shows context and token usage reported by your providers.

![Session usage in Pimi](assets/pimi/usage.jpg)

</details>

## Build from source

Use the Node version in [`.tool-versions`](.tool-versions).

```sh
npm ci
npm run pimi:package:mac
```

On Windows, run `npm run pimi:package:win` after `npm ci`. Builds land in `packages/desktop/release-pimi/`. The macOS app is ad-hoc signed. The Windows installer is unsigned.

[Dev setup and audit notes](pimi/README.md)

## Credits

- Pimi is a fork of [Paseo](https://github.com/getpaseo/paseo), by Mohamed Boudra and contributors. It uses [Electron](https://github.com/electron/electron), [Git](https://github.com/git/git), and [GitHub CLI](https://github.com/cli/cli).
- Blush artwork is adapted from Sophia L. Crownfield’s [_Studies of Ferns_](https://commons.wikimedia.org/wiki/File%3ADrawing%2C_Studies_of_Ferns%2C_early_20th_century_%28CH_18345009%29.jpg).

[Apache 2.0 license](LICENSE)
