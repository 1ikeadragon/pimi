---
title: Connectivity
description: Connect a Pimi client to your daemon through SSH, the relay, or Tailscale.
nav: Connectivity
order: 4
category: Getting started
---

# Connectivity

Your Pimi app connects to the daemon running on your computer or server. Pimi Desktop and the CLI can tunnel through SSH. Mobile clients can connect through your own Pimi Relay or directly with Tailscale.

This is client-to-daemon transport. If you are looking for the service that starts agents from GitHub, Slack, and Discord events, that is [Hub](/docs/hub).

- [SSH](#ssh)
- [Pimi relay](#pimi-relay)
- [Tailscale](#tailscale)

## SSH

SSH transport connects to an existing daemon through your local OpenSSH client. It does not install, start, or configure Pimi on the remote host.

Before connecting:

1. Start the Pimi daemon on the remote host.
2. Confirm `ssh user@host` works with a key or SSH agent. Pimi uses non-interactive SSH and follows your OpenSSH config.

The CLI accepts an SSH URI as its host:

```bash
pimi --host ssh://user@host ls -a
```

The daemon is expected at `127.0.0.1:6767` on the remote host. The port in the SSH URL is the SSH server port:

```bash
pimi --host ssh://user@host:2222 ls -a
```

Set a different remote daemon port with `daemonPort`:

```bash
pimi --host 'ssh://user@host?daemonPort=7777' ls -a
```

Put `--host` before the command. `pimi daemon status` observes the default local home; use `pimi --host ssh://user@host daemon status` to query a remote daemon. `pimi --host ssh://user@host run --cwd /path/on/remote ...` requires a working directory that exists on the remote host.

In Pimi Desktop, open **Settings → Add host → Remote SSH** and enter the same `ssh://` destination, including `:port` or `?daemonPort=` when those differ from the defaults.

If the remote daemon has a password, enter it in **Daemon password**; it is stored with the host and sent on every connection, the same as a direct connection's password. SSH login itself stays key-based — Pimi never prompts for an SSH password.

## Pimi relay

Run [Pimi Relay](https://github.com/1ikeadragon/pimi-relay#pair-a-device) and configure its public address in the daemon's `config.json`. Use TLS for a relay on the internet. This example leaves the relay off until you enable it.

```json
{
  "daemon": {
    "relay": {
      "endpoint": "relay.example.com:443",
      "useTls": true
    }
  }
}
```

Restart Pimi, open **Settings → your host → Pair a device**, and select **Enable relay**. Or run `pimi daemon pair --relay`. Scan the QR code with Pimi on your phone or paste the pairing link there. Keep the link private and use a daemon password.

## Tailscale

Install [Tailscale](https://tailscale.com/download) on the daemon machine and your phone. Sign in to the same tailnet on both devices.

### 1. Find the daemon machine's Tailscale IP

Run this on the daemon machine:

```bash
tailscale ip -4
```

Copy the address it prints. The example below uses `100.101.102.103`.

### 2. Configure the daemon

Open `~/.paseo/config.json` and set `daemon.listen` to the Tailscale IP:

```json
{
  "version": 1,
  "daemon": {
    "listen": "100.101.102.103:6767"
  }
}
```

Keep the other settings already in the file. If it has a `daemon` object, add `listen` inside that object.

To restrict access with a password, see [Password authentication](/docs/configuration#password-authentication).

Restart the daemon:

```bash
pimi daemon restart
```

If Pimi Desktop manages the daemon, use **Settings → your host → Overview → Restart daemon**.

### 3. Connect the phone app

1. Connect Tailscale on your phone.
2. Open Pimi and go to **Settings → Add host → Direct connection**.
3. Enter the Tailscale IP in **Host**.
4. Enter `6767` in **Port**.
5. Leave **Use SSL** off and select **Connect**.

If the host was already paired through the relay, Pimi adds the direct connection to the same host.

## Troubleshooting

- **SSH authentication failed:** Run `ssh user@host` in a terminal and fix the key, agent, host key, or `~/.ssh/config` entry there. Pimi does not prompt for SSH passwords.
- **SSH connects but Pimi is refused:** Run `pimi daemon status` on the remote host. SSH transport does not start the daemon.
- **SSH connects but Pimi reports "Password required":** The remote daemon is password-protected. Remove the SSH connection from the host and add it again, this time entering the daemon password in **Daemon password**.
- **Connection timed out:** Check that Tailscale is connected on both devices and that you used the daemon machine's Tailscale IP.
- **Connection refused:** Run `pimi daemon status` and confirm the daemon is running on the configured IP and port.
- **Config change has no effect:** Run `pimi reload`. `daemon.listen` is a startup setting, so restart when the command reports it.
