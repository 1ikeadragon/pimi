# Pimi

<img src="packages/desktop/assets/pimi-icon.png" alt="Pimi app icon" width="88" />

**Your swarm’s best friend.**

Chat with your agents, track their work, and review the changes in one app.

Pimi will always be free and source-available. Made for everyone, never for sale: commercial use and resale aren't allowed ([license](LICENSE)). Pimi is a passion project of mine. Contributions are welcome through feature requests or bug reports. No PRs accepted for now :)

[Downloads](https://1ikeadragon.github.io/pimi/) · [Android APK](https://github.com/1ikeadragon/pimi/releases/latest/download/Pimi-Android-arm64.apk) · [Release notes](https://github.com/1ikeadragon/pimi/releases/latest)

Work on a Linux dev machine? [Connect it over SSH](docs/remote-ssh.md) and Pimi installs its daemon there.

Replacing Paseo? [Keep your sessions and plugins](docs/paseo-migration.md).

## Use Pimi from your phone

Pimi Mobile lets you chat with your agents, approve permissions, and review changes from anywhere. It works out of the box with the free Pimi Relay, so you don't need a server or a VPN.

1. Install Pimi Desktop and the [Android APK](https://github.com/1ikeadragon/pimi/releases/latest/download/Pimi-Android-arm64.apk).
2. On the desktop, open **Pair a device** and turn on the relay.
3. Scan the QR code with the Android app.

Traffic between your phone and your computer is end-to-end encrypted, so the relay can't read your chats or code ([how it works](SECURITY.md)). Keep the desktop awake and keep the QR code private.

On the same Wi-Fi, you can also pair without any relay.

**Self-hosting:** run your own Pimi Relay and point your desktop at it, or connect over Tailscale or another VPN. One relay can serve all your computers or a group of friends. [Run your own relay](https://github.com/1ikeadragon/pimi/blob/main/docs/self-hosted-relay.md#pair-a-device) · [Personal and team setups](https://github.com/1ikeadragon/pimi/blob/main/docs/self-hosted-relay.md#who-can-share-one-relay) · [Connect over a private VPN](public-docs/connectivity.md#tailscale)

## Build from source

Use the Node version in [`.tool-versions`](.tool-versions).

```sh
npm ci
npm run setup
npm run pimi:package:mac
```

On Windows, run `npm run pimi:package:win` after `npm ci` and `npm run setup`. Builds land in `packages/desktop/release-pimi/`. The macOS app is ad-hoc signed. The Windows installer is unsigned.

[Dev setup](pimi/README.md) · [Security and network activity](SECURITY.md)

## Credits

- Pimi started as a fork of [Paseo](https://github.com/getpaseo/paseo), by Mohamed Boudra and contributors. It uses [Electron](https://github.com/electron/electron), [Git](https://github.com/git/git), and [GitHub CLI](https://github.com/cli/cli).
- The editor uses [CodeMirror](https://codemirror.net/) and [Lezer](https://lezer.codemirror.net/).
- Spaces search uses [Potion Base 2M](https://huggingface.co/minishlab/potion-base-2M) and [Hugging Face Tokenizers](https://github.com/huggingface/tokenizers.js).
- Blush artwork is adapted from Sophia L. Crownfield’s [_Studies of Ferns_](https://commons.wikimedia.org/wiki/File%3ADrawing%2C_Studies_of_Ferns%2C_early_20th_century_%28CH_18345009%29.jpg).
- Community appearances draw from [Ayu](https://github.com/ayu-theme/vscode-ayu), [One Dark Pro](https://github.com/Binaryify/OneDark-Pro), [Nord](https://www.nordtheme.com/docs/colors-and-palettes/), [Gruvbox](https://github.com/ellisonleao/gruvbox.nvim), and [Catppuccin](https://catppuccin.com/palette/). [Palette licenses](packages/app/public/pimi-textures/PALETTE-LICENSES.txt)

## Disclaimer

Pimi's Attack mode and desktop testing tools are designed for use on your own applications and property, with your full knowledge and consent. You are responsible for ensuring you have authorization to test any software you target. Do not use these tools against applications, systems, or services you do not own or do not have explicit permission to test.

[PolyForm Noncommercial 1.0.0 license](LICENSE)
