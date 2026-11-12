# Remote dev machine over SSH

Enter `user@devbox` and Pimi installs its daemon on that Linux machine, starts it, and connects. Agents, terminals, git and Review then run on the remote machine, while the app runs on yours. Add it from Settings > Connections > **Remote dev machine (SSH)**, the Add host menu, the command palette, or the **Where to work** onboarding step.

## What Pimi does

Every step runs through your system `ssh`, so `~/.ssh/config`, `ProxyJump`, keys and your agent apply. Pimi stores no SSH secret and runs `ssh` with `BatchMode=yes`, so a key that needs a passphrase has to be in your agent. A first-seen host key is recorded in `known_hosts` (`StrictHostKeyChecking=accept-new`); a changed key is refused.

1. **Probe.** `uname -s`/`-m`, `$HOME`, free disk, libc, Node versions, systemd, and whether a daemon already answers on `127.0.0.1:6767` and at which version.
2. **Install when needed.** If no daemon runs at the desktop's version, Pimi installs it into `~/.pimi/runtime/<version>/`:
   - The bundle is `Pimi-daemon-linux-x64.tar.gz` or `-arm64.tar.gz`, attached to the GitHub release that matches the desktop version. The desktop downloads it only from a release GitHub reports as immutable (the check the app updater uses), verifies it against the SHA-256 GitHub computed for that asset, and caches it, so the desktop installer stays small. A release that is not immutable stops the install with an error before anything reaches the remote; the release's own `SHA256SUMS.txt` is not trusted.
   - The desktop sends it over `ssh` and the remote checks its SHA-256 before unpacking.
   - Node 24 or newer is required. Pimi uses the remote's `node` when it is new enough. Otherwise the remote downloads the official tarball for one pinned Node version from nodejs.org into `~/.pimi/runtime/node/` and checks it against the SHA-256 that ships inside the desktop (`REMOTE_NODE_SHA256`, taken from the GPG-signed `SHASUMS256.txt.asc`). The remote never fetches a checksum file.
   - node-pty ships Linux prebuilds for both architectures, so nothing compiles on the remote.
3. **Start.** The daemon listens on `127.0.0.1` only, started with `setsid nohup`. It gets the `PATH` your own login shell has (read with `$SHELL -ilc`, 10 second limit), so agent CLIs you installed through `~/.bashrc` or `~/.zshrc`, such as opencode, claude or nvm's node, are found even though `ssh` runs without those files. The `PATH` is read when the daemon starts; restart it after installing a new CLI. Pimi waits until the WebSocket accepts clients, then tunnels with `ssh -W` as for any SSH host.
4. **Every connect repeats the check.** A stopped daemon is restarted, and a new desktop version upgrades the remote, which keeps the previous version for one rollback.

Turn on **Keep the daemon running with systemd** in the dialog to use a `systemd --user` unit (`pimi-daemon.service`, `Restart=on-failure`) when the machine has one. The unit stops at logout unless you run `loginctl enable-linger <user>`.

## Requirements

- Linux on x86_64 or arm64 with glibc (Ubuntu, Debian, Fedora). Alpine (musl) and macOS remotes are not supported.
- `tar`, `curl` or `wget`, `sha256sum` or `shasum`, about 900 MB free in `$HOME`.
- Internet access on the remote for Node, unless it already has Node 24 or newer.

## Errors

| Message                            | What to do                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| SSH could not sign in              | Run `ssh user@host` in a terminal, add the key with `ssh-add`.                                         |
| Host key does not match            | The machine was reinstalled or something is wrong. `ssh-keygen -R host` only if you expect the change. |
| Could not reach the host           | Check the name, port, VPN and `sshd`.                                                                  |
| Unsupported OS, CPU or libc        | Use a glibc Linux on x86_64 or arm64.                                                                  |
| Could not download Node.js         | Give the remote internet access, or install Node 24 or newer on it.                                    |
| Out of disk space                  | Free space in `$HOME`.                                                                                 |
| Another Pimi daemon holds the port | Stop it with `pimi daemon stop`, or use another daemon port in the `ssh://` URI.                       |
| Daemon did not start               | Read `~/.pimi/daemon-remote.log` on the remote.                                                        |
| Release is not verified immutable  | Pimi installs nothing. Reinstall Pimi from the official download, or ask the maintainer to republish.  |

## Files on the remote

`~/.pimi` holds the daemon state, `~/.pimi/runtime/<version>/` the installed bundle, `~/.pimi/runtime/current` the active one, and `~/.pimi/daemon-remote.log` the output of a nohup start. Delete `~/.pimi/runtime` to force a reinstall.

## Development

`scripts/build-daemon-bundle.mjs <x64|arm64> <dir>` builds a bundle after `npm run build:server`; the release workflow builds both and attaches them. In an unpackaged desktop, `PIMI_REMOTE_DAEMON_BUNDLE_DIR=<dir>` uses those files instead of downloading, `PIMI_REMOTE_DAEMON_VERSION` overrides the version the remote must run, and `PIMI_SSH_CONFIG=<file>` adds `-F <file>` to every ssh Pimi starts. Packaged builds ignore the first two.
