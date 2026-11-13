# Remote dev machine over SSH

Enter `user@devbox` and Pimi installs its daemon on that Linux machine, starts it, and connects. Agents, terminals, git and Review then run on the remote machine, while the app runs on yours. Add it from Settings > Connections > **Remote dev machine (SSH)**, the Add host menu, the command palette, or the **Where to work** onboarding step.

## What Pimi does

Every step runs through your system `ssh`, so `~/.ssh/config`, `ProxyJump`, keys and your agent apply. Keys and your agent are used first. If the server asks for a password, passphrase or code, Pimi asks for it in the app and keeps it in memory until you quit. A first-seen host key is recorded in `known_hosts` (`StrictHostKeyChecking=accept-new`); a changed key is refused.

1. **Probe.** `uname -s`/`-m`, `$HOME`, free disk, libc, Node versions, systemd, and whether a daemon already answers on `127.0.0.1:6767` and at which version. Only a daemon at another version is also asked how many agents and terminals it has (it costs two Node starts on the remote), because only an upgrade needs the count.
2. **Install when needed.** If no daemon runs at the desktop's version, Pimi installs it into `~/.pimi/runtime/<version>/`:
   - The bundle is `Pimi-daemon-linux-x64.tar.gz` or `-arm64.tar.gz`, attached to the GitHub release that matches the desktop version. The desktop downloads it only from a release GitHub reports as immutable (the check the app updater uses), verifies it against the SHA-256 GitHub computed for that asset, and caches it, so the desktop installer stays small. A release that is not immutable stops the install with an error before anything reaches the remote; the release's own `SHA256SUMS.txt` is not trusted.
   - The desktop sends it over `ssh` and the remote checks its SHA-256 before unpacking.
   - Node 24 or newer is required. Pimi uses the remote's `node` when it is new enough. Otherwise the remote downloads the official tarball for one pinned Node version from nodejs.org into `~/.pimi/runtime/node/` and checks it against the SHA-256 that ships inside the desktop (`REMOTE_NODE_SHA256`, taken from the GPG-signed `SHASUMS256.txt.asc`). The remote never fetches a checksum file.
   - node-pty ships Linux prebuilds for both architectures, so nothing compiles on the remote.
3. **Start.** The daemon listens on `127.0.0.1` only, started with `setsid nohup`. It gets the `PATH` your own login shell has (read with `$SHELL -ilc`, 10 second limit), so agent CLIs you installed through `~/.bashrc` or `~/.zshrc`, such as opencode, claude or nvm's node, are found even though `ssh` runs without those files. The `PATH` is read when the daemon starts; restart it after installing a new CLI. Pimi waits until the WebSocket accepts clients, then tunnels with `ssh -W` as for any SSH host. The tunnel sends an ssh keepalive every 15 seconds and gives up after four misses.
4. **Every connect repeats the check.** A stopped daemon is restarted, and a new desktop version upgrades the remote, which keeps the previous version for one rollback.

Turn on **Keep the daemon running with systemd** in the dialog to use a `systemd --user` unit (`pimi-daemon.service`, `Restart=on-failure`) when the machine has one. The unit stops at logout unless you run `loginctl enable-linger <user>`.

## Connection sharing

On macOS and Linux every ssh Pimi starts for one machine (the probe, the app's tunnel, the agent endpoint's tunnels) shares one connection: `ControlMaster=auto`, `ControlPersist=60`, and a `ControlPath` of `/tmp/pimi-<uid>-<hash of PIMI_HOME>/m-%C`. That directory is mode 0700 and stays short because a unix socket path must be under 104 bytes. A reconnect costs a round trip instead of a TCP connect, key exchange and sign-in. Things to know:

- These options are on the command line, so they override a `ControlMaster` or `ControlPath` in your `~/.ssh/config`. `PIMI_SSH_CONFIG` still applies.
- The first ssh for a machine becomes the master and takes the sign-in prompt; the rest attach without one. Removing a machine ends its master.
- One TCP connection carries all channels, so a dead path drops the app's tunnel and the agent endpoint's together. The master's keepalive finds it, and the app reconnects as it does for any dropped tunnel.
- Close a tunnel by ending its stdin, as `startSshTunnel` does. Killing a `-W` client leaves the master holding the channel and the daemon's socket open, and the master never exits.
- Quitting the app stops every master and removes the sockets. After a crash a master exits on its own once idle; a stale socket is replaced by the next connect.
- Windows keeps one ssh per use: Win32-OpenSSH has no multiplexing.

## Sign-in prompts

The desktop runs ssh with `SSH_ASKPASS_REQUIRE=force`, so ssh calls Pimi's askpass program only when it would otherwise prompt. The program (`bin/pimi-ssh-askpass` on macOS, the Windows helper exe in askpass mode) relays ssh's prompt text to the main process over a private socket or pipe, authenticated by a per-spawn token. The answer never goes through env, argv or disk. Three things are easy to get wrong:

- Answers to password and passphrase prompts are cached in memory per machine and prompt; one-time codes are not. A reconnect after the shared connection ended signs in again, so without the cache it would ask.
- Cancelling kills that ssh at once (ssh would otherwise send empty passwords) and stops background reconnects from prompting again for that machine. Adding it or upgrading it again, or restarting the app, prompts again.
- The Windows askpass must stay an exe. Win32-OpenSSH starts it with the server-controlled prompt on the command line, which a `.cmd` or script would hand to `cmd.exe`.

`SSH_ASKPASS_REQUIRE` needs OpenSSH 8.4. On an older ssh the desktop keeps `BatchMode=yes` and the sign-in error says so. Hosts added in the app never use the daemon's own `ssh://` support, which stays in batch mode like the CLI.

## Agent endpoint socket

Agents on this computer can start agents on a saved SSH host through the local daemon. The daemon has no ssh credentials or prompt channel, so it cannot use an `ssh://` connection to such a host. The desktop opens a local socket instead, and the daemon registers that socket as the host's connection.

- IPC `remote_ssh_agent_endpoint` returns `unix://<PIMI_HOME>/run/ssh-<hash>.sock` (macOS; `/tmp/pimi-<uid>-<home hash>/` when `PIMI_HOME` is too deep for a socket path), or `pipe://\\.\pipe\pimi-ssh-<hash>` (Windows). It is idempotent per host, SSH port and daemon port. `remote_ssh_agent_endpoint_close` closes one.
- Every connection to the socket starts one `ssh -W` tunnel through the same auth path as the app's own connection, so keys, the agent, cached answers and prompts in the app all apply. `run/` is mode 0700 and the socket 0600.
- The listener lives as long as the app. Quitting closes all of them and unlinks the files; a stale file left by a crash is replaced on the next open.
- This path never installs, upgrades or starts the remote daemon, because the daemon retries every few seconds and each retry would run a probe. The app's own connection to that host does that on every connect. Until it has, the endpoint tunnels to a closed port and the daemon sees the host as offline.
- A socket path over 100 bytes is refused (macOS `sun_path` is 104). Use a shorter `PIMI_HOME` if you hit it.

## Requirements

- Linux on x86_64 or arm64 with glibc (Ubuntu, Debian, Fedora). Alpine (musl) and macOS remotes are not supported.
- `tar`, `curl` or `wget`, `sha256sum` or `shasum`, about 900 MB free in `$HOME`.
- Internet access on the remote for Node, unless it already has Node 24 or newer.

## Errors

| Message                            | What to do                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| SSH could not sign in              | Check the user name and password or key.                                                               |
| Host key does not match            | The machine was reinstalled or something is wrong. `ssh-keygen -R host` only if you expect the change. |
| Could not reach the host           | Check the name, port, VPN and `sshd`.                                                                  |
| Unsupported OS, CPU or libc        | Use a glibc Linux on x86_64 or arm64.                                                                  |
| Could not download Node.js         | Give the remote internet access, or install Node 24 or newer on it.                                    |
| Out of disk space                  | Free space in `$HOME`.                                                                                 |
| Another Pimi daemon holds the port | Stop it with `pimi daemon stop`, or use another daemon port in the `ssh://` URI.                       |
| Daemon did not start               | Read `~/.pimi/daemon-remote.log` on the remote.                                                        |
| Release is not verified immutable  | Pimi installs nothing. Reinstall Pimi from the official download, or ask the maintainer to republish.  |

## Files on the remote

`~/.pimi` holds the daemon state, `~/.pimi/runtime/<version>/` the installed bundle, `~/.pimi/runtime/current` the active one, and `~/.pimi/daemon-remote.log` the output of a nohup start. Delete `~/.pimi/runtime` to force a reinstall. Agents also write into `~/.claude/skills`, `~/.agents/skills` and `~/.codex/skills` (Pimi skills) and, with terminal agent hooks on, into the agent config files; Pimi never changes `loginctl` linger and never touches provider session history.

## Uninstall

Host settings > Danger zone > **Uninstall Pimi from this machine** (desktop app, hosts added over SSH). The sheet first looks at the machine and then offers:

- Always: stop the daemon, remove the systemd unit if there is one, delete `~/.pimi/runtime` and `daemon-remote.log`, and remove the host from Pimi. Terminal workers that belong to this `~/.pimi` are stopped too; a daemon or worker owned by another `PIMI_HOME` is not touched, and a program that answers on the daemon port but does not hold `~/.pimi` is left running.
- Running agents or terminals are counted and must be acknowledged before the button works.
- A second, unticked box also deletes `~/.pimi`: agents, settings, and `~/.pimi/worktrees`. Worktrees Pimi created can hold uncommitted work, and phones paired with that daemon lose it. Without the box, adding the machine again finds the same `server-id` and the earlier agents.

While an uninstall runs, the desktop refuses to run the installer for that machine, because every connect runs it and would otherwise reinstall the daemon the moment it stops. The mark clears when the uninstall fails or is cancelled, and when the machine is added again.

If ssh cannot reach the machine nothing is removed, and the sheet offers **Remove from Pimi only**. To clean up by hand: `systemctl --user disable --now pimi-daemon.service` if you used systemd, stop the process named in `~/.pimi/pimi.pid`, then delete `~/.pimi/runtime`.

With the data box ticked and the app connected, the daemon first removes Pimi's skills. The app also turns terminal agent hooks off before it uninstalls, which removes the hook entries from the agent config files. If the app was not connected, those entries and skills stay and the result says so.

## Running as root

Claude Code refuses to start as uid 0 when it is asked to allow Bypass permissions, and Pimi always asks so a later switch to Bypass works. When the daemon runs as root, Pimi sets `IS_SANDBOX=1` in the environment of every Claude process it spawns, so every mode, including Bypass, works. Bypass as root can do anything to the machine. An `IS_SANDBOX` value you set for the daemon is kept. Exports in `~/.bashrc` do not reach the daemon, which takes only `PATH` from your login shell.

## Development

`scripts/build-daemon-bundle.mjs <x64|arm64> <dir>` builds a bundle after `npm run build:server`; the release workflow builds both and attaches them. In an unpackaged desktop, `PIMI_REMOTE_DAEMON_BUNDLE_DIR=<dir>` uses those files instead of downloading, `PIMI_REMOTE_DAEMON_VERSION` overrides the version the remote must run, and `PIMI_SSH_CONFIG=<file>` adds `-F <file>` to every ssh Pimi starts. Packaged builds ignore the first two.
