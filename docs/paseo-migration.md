# Move from Paseo to Pimi

Use the same OS account and machine so Pimi can find your repositories, provider history, and plugin paths. Paseo keeps its daemon home at `~/.paseo`. Pimi uses `~/.pimi`. When Pimi’s daemon starts, no `~/.pimi` exists, and `~/.paseo` does, it renames `~/.paseo` to `~/.pimi` and rewrites absolute paths inside the home’s JSON files. The desktop app stops a Paseo daemon still running from that home before the move. The CLI and a daemon started by hand refuse until you stop it. A custom Paseo home (`PASEO_HOME`) is not moved: point `PIMI_HOME` at the same directory in Pimi’s launch environment. Verify the desktop and CLI both use that home before continuing.

## 1. Find and back up your data

1. Before stopping Paseo, run `paseo daemon status --json` to identify the daemon home and listener. If you use multiple hosts or profiles, repeat this for each one. Save a private inventory from `paseo ls -a -g --json` and `paseo plugin ls --json`, adding `--home <path>` for a custom local home if your Paseo version supports it. On older builds, use the app to inventory sessions and the daemon config to inventory plugins.
2. Wait for active agents and terminals to finish. Quit Paseo and stop its daemon using the same launcher that started it. Disable its auto-start before opening Pimi, then confirm the old daemon has stopped. Do this from a regular terminal if your current agent runs under that daemon.
3. Make a private backup of the entire daemon home, including hidden files. Keep the original paths and permissions recorded. The home holds chat records, project and workspace registries, config, daemon identity, and installed plugin data. Keep the backup encrypted or accessible only to your OS account. It can contain chats, credentials, and the relay private key.
4. Back up the old desktop profile if present, such as `~/Library/Application Support/Paseo` on macOS or `%APPDATA%\Paseo` on Windows. Back up custom plugin source directories referenced by the config, including any outside the daemon home, and preserve their lockfiles and uncommitted changes. Keep provider-managed history and credentials in place. Back up any worktrees with local changes, including untracked files.

Keep repositories and plugin sources at their original absolute paths. Worktrees under `~/.paseo/worktrees` move with the home and are repaired on migration. If `~/.pimi` already exists, Pimi leaves `~/.paseo` alone: back up both and choose the home you want to use before continuing. Pimi’s desktop profile reuses the old one, and the desktop app copies the saved remote hosts, drafts, layout, and UI preferences across on first launch, and Pimi for Android copies its paired hosts and settings across on first launch after the update.

## 2. Start Pimi and check what carried over

1. Install the [current Pimi desktop release](https://github.com/1ikeadragon/pimi/releases/latest). In the active home’s `config.json`, set `daemon.relay.enabled` to `false` before starting Pimi. Also clear relay overrides from the launcher you’ll use. If a password override was in use, make sure the Pimi daemon still requires a password before allowing remote access. Keep the backup untouched.
2. Open Pimi and run `pimi daemon status --json`. Confirm the daemon version and home match your Pimi installation and existing data. Run `pimi ls -a -g --json` and compare session IDs, including archived sessions, against the inventory. Open an older chat and resume a session you’re comfortable using. Check that its workspace opens and uncommitted files are still present.
3. Run `pimi plugin ls --json`. Compare plugin IDs, source paths, and enabled state with the inventory. Exercise a feature from each trusted plugin you rely on. Pimi reads `pimi-plugin.json`, `requirements.pimi`, `@pimi/*` imports, and `context.pimi` only. Rename those in a Paseo plugin, and replace any use of the old `paseo` CLI or an upstream-only API. Project scripts move from `paseo.json` to `pimi.json`, and `PASEO_*` environment variables become `PIMI_*`. Keep disabled plugins disabled and fix incompatible plugins on copies before switching their configured paths. [Plugin reference](plugins.md)
4. If you use Android, [set up your own relay](self-hosted-relay.md#pair-a-device) and pair Pimi for Android with a fresh QR code. Open a migrated chat on the phone before retiring the old connection.

Use the bundled CLI if `pimi` isn’t on your path.

- macOS — `/Applications/Pimi.app/Contents/Resources/bin/pimi`
- Windows — `C:\Program Files\Pimi\resources\bin\pimi.cmd` for a default install

## 3. Retire the old installation

After those checks pass, quit any remaining Paseo processes and remove the old app through the OS or its original installer. Check that none of the paths being removed contain a plugin source or dependency. Remove old CLI links, package-manager installs, login items, services, and shell entries only after checking exactly what owns them. Move the unused Paseo desktop profile to your private backup before considering deletion. Keep `~/.pimi`, plugin sources, provider data, repositories, and anything a verified Pimi plugin or launcher still needs. Reopen a migrated chat and check your plugins again after cleanup.

If any check fails, stop cleanup. Keep the backup and both installers. To roll back, stop Pimi and save a separate copy of its current state before restoring the backup or reopening Paseo. Preserve any chats and edits made after the switch so they can be recovered separately. Start only one daemon against that home.

## Prompt for your agent

Run this from an agent outside the Paseo daemon so it can continue through the handoff.

```text
Help me replace Paseo Desktop with Pimi on this machine. Preserve all sessions,
including archived sessions, and keep my custom plugins working.

Start read-only. Find the actual daemon home, launch method, listener, desktop
profile, active agents, session IDs, and configured plugin IDs, sources, and
enabled states. Find provider history and any worktrees or plugin sources
outside the home. Report paths and differences without printing secrets or
chat contents. Use the official Pimi release and the migration guide.

Show me the backup destinations and exact cutover steps. Ask before stopping
the daemon. Once idle and approved, stop it, make private backups, and verify
they are readable before starting Pimi. Let Pimi move the
daemon home to ~/.pimi, and keep absolute workspace and plugin paths. Leave relay off until I configure my own.
If Pimi already has a different home with data, stop and ask which home to use.

Compare session IDs and plugin inventory in Pimi. Ask me to verify a resumed
chat and any plugin features you cannot exercise safely. Keep disabled plugins
disabled. Stop if any session is missing, any path changes unexpectedly, or a
plugin I rely on fails. Give me the rollback steps and preserve both copies.

After verification, show the exact Paseo-only app, binaries, startup items,
and unused profile paths you found. Ask me before removing them. Keep
~/.pimi, provider data, plugin sources, repos, and backups. Report
what you verified, what I checked, and where the rollback copy is.
```
