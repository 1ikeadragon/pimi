# Pimi

<img src="packages/desktop/assets/pimi-icon.png" alt="Pimi app icon" width="88" />

**Your swarm’s best friend.**

Chat with your agents, track their work, and review the changes in one app.

[Downloads](https://1ikeadragon.github.io/pimi/) · [Android APK](https://github.com/1ikeadragon/pimi/releases/latest/download/Pimi-Android-arm64.apk) · [Release notes](https://github.com/1ikeadragon/pimi/releases/latest)

Work on a Linux dev machine? [Connect it over SSH](docs/remote-ssh.md) and Pimi installs its daemon there.

Replacing Paseo? [Keep your sessions and plugins](docs/paseo-migration.md).

## Use Pimi from your phone

Install Pimi Desktop and the [Android APK](docs/android.md#pimi-apk). Run Pimi Relay on a server you control, point your desktop at it, and scan the desktop’s **Pair a device** QR code in the Android app. Keep the desktop awake, set a daemon password, and keep the QR code private.

One relay can serve all your computers or a group of friends. Pair each computer separately and share the relay address with friends who want to pair their own computers. [Personal and team setups](https://github.com/1ikeadragon/pimi/blob/main/docs/self-hosted-relay.md#who-can-share-one-relay)

[Set up your own relay and pair Android](https://github.com/1ikeadragon/pimi/blob/main/docs/self-hosted-relay.md#pair-a-device) · [Connect over a private VPN](public-docs/connectivity.md#tailscale)

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

[Apache 2.0 license](LICENSE)
