# Self-hosted relay

`packages/relay/src/node-relay.ts` is a Node server that speaks the same relay protocol as the Cloudflare Durable Object in `cloudflare-adapter.ts`. Run it when you want remote access through a box you control. The relay stays untrusted: it pipes opaque frames by session id, and the daemon and client secure the session end to end ([relay-endpoint-security.md](relay-endpoint-security.md)).

## Differences from the Cloudflare adapter

- Protocol version 2 only. A missing or `v=1` request gets HTTP 400. Cloudflare still serves `v=1`.
- A plain `GET /ws` without an upgrade returns 426 before the query is validated.
- A daemon data socket that was replaced no longer closes the client sockets when the old one finishes closing.
- Nothing is persisted. Sessions, buffered frames, and counters live in memory and vanish on restart; daemons and clients reconnect on their own.

## Build and run

```bash
npm run build:node-relay --workspace=@pimi/relay   # writes packages/relay/dist-node/node-relay.mjs, `ws` bundled
node node-relay.mjs                               # Node 22+, binds 127.0.0.1:8787
```

The relay serves plain HTTP and WebSocket. Put a TLS proxy in front of it and never expose the port directly. `GET /health` returns `{"status":"ok"}`.

## Limits

Set through environment variables. Defaults in parentheses.

| Variable                                       | Meaning                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `PIMI_RELAY_HOST` / `PIMI_RELAY_PORT`          | Bind address (`127.0.0.1` / `8787`)                                                              |
| `PIMI_RELAY_MAX_MESSAGE_BYTES`                 | Largest single frame (32 MiB); larger closes the socket with 1009                                |
| `PIMI_RELAY_MAX_SESSIONS`                      | Distinct session ids (1000)                                                                      |
| `PIMI_RELAY_MAX_SOCKETS`                       | Live sockets overall (4000)                                                                      |
| `PIMI_RELAY_MAX_SOCKETS_PER_IP`                | Live sockets per client IP (100)                                                                 |
| `PIMI_RELAY_MAX_UPGRADES_PER_IP_PER_MINUTE`    | New connections per IP per minute (120), then HTTP 429                                           |
| `PIMI_RELAY_MAX_CLIENT_SOCKETS_PER_CONNECTION` | Client sockets per connection id (8)                                                             |
| `PIMI_RELAY_MAX_PENDING_FRAMES` / `_BYTES`     | Frames held for a daemon data socket that has not connected (200 / 16 MiB), oldest dropped first |
| `PIMI_RELAY_MAX_BUFFERED_BYTES`                | Close a peer whose send buffer passes this (64 MiB)                                              |
| `PIMI_RELAY_PING_INTERVAL_MS`                  | Ping every interval; a socket that misses a pong is terminated (30000)                           |
| `PIMI_RELAY_IDLE_TIMEOUT_MS`                   | Close data sockets with no frame for this long, control sockets exempt (1800000; 0 disables)     |
| `PIMI_RELAY_TRUST_PROXY`                       | Read `X-Forwarded-For` when the TCP peer is loopback (`1`; set `0` with no proxy)                |

Logs are JSON lines of events only. They carry no frame contents and no full session ids (a short hash tags a session); client IPs appear only on rate-limit rejections.

## Deploy on Ubuntu

Use distro packages: `apt install nodejs caddy`. Create the service user and install the bundle root-owned, so the service cannot modify its own code:

```bash
useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin pimi-relay
install -d -o root -g root -m 755 /opt/pimi-relay
install -o root -g root -m 644 node-relay.mjs /opt/pimi-relay/node-relay.mjs
```

`/etc/systemd/system/pimi-relay.service`:

```ini
[Unit]
Description=Pimi relay (self-hosted)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pimi-relay
Group=pimi-relay
ExecStart=/usr/bin/node /opt/pimi-relay/node-relay.mjs
Environment=PIMI_RELAY_HOST=127.0.0.1
Environment=PIMI_RELAY_PORT=8787
Restart=always
RestartSec=2

NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateUsers=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=no
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressAllow=localhost
IPAddressDeny=any
UMask=0077
MemoryMax=1G
TasksMax=256
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
```

`/etc/caddy/Caddyfile` (Caddy gets and renews the Let's Encrypt certificate; ports 80 and 443 must be open):

```
relay.stateless.computer {
	handle /ws {
		reverse_proxy 127.0.0.1:8787
	}
	handle /health {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		respond "Not found" 404
	}
}
```

Firewall: allow 22, 80, and 443 only. The relay's own port stays on loopback, and the unit denies every non-loopback address.

## Point a daemon at it

In the daemon's `config.json`:

```json
{
  "daemon": {
    "relay": {
      "enabled": true,
      "endpoint": "relay.example.com:443",
      "useTls": true,
      "publicEndpoint": "relay.example.com:443",
      "publicUseTls": true
    }
  }
}
```

Or use `PASEO_RELAY_ENDPOINT`, `PASEO_RELAY_USE_TLS`, `PASEO_RELAY_PUBLIC_ENDPOINT`, and `PASEO_RELAY_PUBLIC_USE_TLS`. Restart the daemon, then run `pimi daemon pair` for a new link: the pairing offer embeds the relay endpoint, so links made for the old relay stop working.

Anyone who knows a session id can open a socket in it and replace the daemon's control socket, so the relay is only as available as that id is secret. The id is not a credential for the session contents, which stay behind the Noise handshake and the daemon key.
