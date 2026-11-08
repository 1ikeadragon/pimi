# Pimi

<img src="packages/desktop/assets/pimi-icon.png" alt="Pimi app icon" width="88" />

**Your swarm’s best friend.**

Start in chat, split work across agents, and review what they changed in one app.

[Download for macOS or Windows](https://1ikeadragon.github.io/pimi/) · [Watch Pimi build an expense export](assets/pimi/dvra-expense-export-demo.mp4)

[![Play the Pimi promo](assets/pimi/promo.jpg)](assets/pimi/promo.mp4)

## What’s inside

- **Chat.** Queue a follow-up or fork a conversation into another provider. Click Pimi in the bottom-right corner and say “Start a new task” or “Open Work.”
- **Agent grid.** Watch your agents work side by side. Open a pane’s chat when you need to jump in.
- **Tasks and Work.** Start from a brief, send agents to chat or separate Git worktrees, and read their reports in one place. The board moves with the work. You can move cards yourself too.
- **Review.** Compare changes across worktrees and repos. Read a file tour or jump to a changed line in your editor.
- **Memory and Spaces.** Share project notes across providers. Paste links, images, and rough ideas into Spaces, then give an agent the card ID.
- **Providers.** Check for harness updates in Settings. Pimi lets you know when it finds a newer version.

![Pimi onboarding](assets/pimi/onboarding.jpg)

![Tasks board with agents working across repositories](assets/pimi/task-board.jpg)

![Two worktree diffs side by side](assets/pimi/review.jpg)

[Work board](assets/pimi/board.jpg) · [Agent reports](assets/pimi/tasks.jpg) · [File tour](assets/pimi/review-tour.jpg)

## Build from source

Use the Node version in [`.tool-versions`](.tool-versions).

```sh
npm ci
npm run pimi:package:mac
```

On Windows, run `npm run pimi:package:win` after `npm ci`. Builds land in `packages/desktop/release-pimi/`. The macOS preview is ad-hoc signed.

[Dev setup and audit notes](pimi/README.md)

## Credits

- Pimi is a fork of [Paseo](https://github.com/getpaseo/paseo), by Mohamed Boudra and contributors. It uses [Electron](https://github.com/electron/electron), [Git](https://github.com/git/git), and [GitHub CLI](https://github.com/cli/cli).
- Blush artwork is adapted from Sophia L. Crownfield’s [_Studies of Ferns_](https://commons.wikimedia.org/wiki/File%3ADrawing%2C_Studies_of_Ferns%2C_early_20th_century_%28CH_18345009%29.jpg).
- The promo uses [Brag](https://github.com/latent-spaces/brag) and [Hyperframes](https://github.com/heygen-com/hyperframes), with music by [Sascha Ende](https://ende.app/en) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

[Apache 2.0 license](LICENSE)
