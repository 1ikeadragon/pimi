---
name: pimi-help
description: Diagnose Pimi setup, hosts, providers, updates, logs, and connectivity.
---

# Pimi help

Answer using the installed version and the affected host. Use the **pimi** skill when the user wants you to operate agents, workspaces, or automations.

## Find the current instructions

Use the local Pimi checkout when available. For an installed release, start with its release notes and check the linked setup or configuration guide. Prefer documentation for the user's version when behavior differs between releases.

- [Pimi downloads](https://1ikeadragon.github.io/pimi/)
- [Desktop release notes](https://github.com/1ikeadragon/pimi/releases/latest)
- [Android setup](https://github.com/1ikeadragon/pimi/blob/main/docs/android.md)
- [Network activity and pairing](https://github.com/1ikeadragon/pimi/blob/main/SECURITY.md)
- [Troubleshooting](https://github.com/1ikeadragon/pimi/blob/main/public-docs/troubleshooting.md)
- [Custom providers](https://github.com/1ikeadragon/pimi/blob/main/public-docs/custom-providers.md): other API backends, ACP agents, custom binaries, and provider aliases in `config.json`

## Identify the host

Use **Settings → About** to compare the app version with the host version. In the affected host's settings, open **Host → Full status**. A desktop install may manage a local daemon and connect to other daemons. Provider binaries, credentials, workspaces, and daemon logs live on the machine that runs the selected daemon.

For a remote host, identify whether the connection uses a relay, LAN, or VPN. Check which relay is configured before diagnosing pairing. Use the daemon's reported home and endpoint rather than assuming a default.

## Diagnose

Use read-only checks on the daemon machine. Add `--host <address>` if the CLI would otherwise target a different host.

```bash
pimi --version
pimi daemon status --json
pimi provider diagnostic <provider> --json
pimi provider ls --json
pimi usage ls --json
```

`pimi provider ls` shows which providers the daemon found, including custom ones. `pimi usage ls` shows provider account quotas and balances; use it for rate-limit or out-of-credit questions. It does not report an agent's token consumption.

If `pimi` is missing from the shell, use the binary shipped with the desktop install:

- macOS — `/Applications/Pimi.app/Contents/Resources/bin/pimi`
- Windows — `C:\Program Files\Pimi\resources\bin\pimi.cmd`

Use the status-reported home for `config.json` and `daemon.log`. On macOS, the app's own log is `~/Library/Logs/Pimi/main.log`. On Windows, check `%APPDATA%\Pimi\logs\main.log`. Compare the reported provider binary, daemon `PATH`, and provider version with a login shell when diagnosing command discovery.

For a desktop update, open **Settings → About → Check for updates**. For Android, install the signed APK over the existing Pimi app. For a separately managed daemon, update the checkout or package that starts it. Get permission before restarting a live daemon or changing network access.

## Report a bug

Capture the app and daemon versions, OS, install and connection methods, exact error, and a short reproduction. Read only the relevant log lines and redact credentials, pairing offers, tokens, passwords, and user code before sharing. [Pimi GitHub Issues](https://github.com/1ikeadragon/pimi/issues)
