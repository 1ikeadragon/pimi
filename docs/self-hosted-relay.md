# Self-hosted relay

`packages/relay/src/node-relay.ts` is a Node server that speaks the Pimi relay protocol (v2). Run it when you want remote access through a box you control. The relay stays untrusted: it pipes opaque frames by session id, and the daemon and client secure the session end to end ([relay-endpoint-security.md](relay-endpoint-security.md)).

## Behavior

- Protocol version 2 only. A missing or `v=1` request gets HTTP 400.
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
relay.example.com {
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

Update the relay by rebuilding the bundle, copying it to `/opt/pimi-relay/node-relay.mjs` with the same `install` line, and running `systemctl restart pimi-relay`. Daemons and clients reconnect within about 30 seconds.

## Behind Cloudflare

The relay works with the Cloudflare proxy (orange cloud) on. Cloudflare passes WebSocket upgrades, and the daemon's 10-second pings keep sockets under Cloudflare's 100-second idle cutoff.

- Set SSL/TLS to **Full (strict)**. Caddy keeps its Let's Encrypt certificate; renewal goes over port 80 through Cloudflare.
- Cloudflare does not proxy SSH. Connect to the origin IP, not the hostname.
- Every request now arrives from a Cloudflare address, so the per-IP limits need the real client IP. Take it from `CF-Connecting-IP`, and only for peers in Cloudflare's ranges, since a client can put anything in `X-Forwarded-For`:

```
(relay_proxy) {
	@cf remote_ip <ranges from https://www.cloudflare.com/ips-v4 and /ips-v6>
	handle @cf {
		reverse_proxy 127.0.0.1:8787 {
			header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}
		}
	}
	handle {
		reverse_proxy 127.0.0.1:8787
	}
}

relay.example.com {
	handle /ws {
		import relay_proxy
	}
	handle /health {
		import relay_proxy
	}
	handle {
		respond "Not found" 404
	}
}
```

Use `handle`, not `route`, for `/ws` and `/health`: Caddy runs `handle` blocks before `route`, so the catch-all 404 would win.

- Allow 80 and 443 only from Cloudflare's ranges, once DNS everywhere returns Cloudflare addresses (a daemon still resolving the origin IP drops until its cache expires):

```bash
for r in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do
  ufw allow proto tcp from "$r" to any port 80,443 comment cloudflare
done
ufw delete allow 80/tcp && ufw delete allow 443/tcp
```

Cloudflare's ranges change rarely; rerun the loop when they do. The origin IP stays in DNS history, so move the box to a new IP if you want it hidden.

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

Or use `PIMI_RELAY_ENDPOINT`, `PIMI_RELAY_USE_TLS`, `PIMI_RELAY_PUBLIC_ENDPOINT`, and `PIMI_RELAY_PUBLIC_USE_TLS`. Restart the daemon, then pair again: the pairing offer embeds the relay endpoint, so links made for the old relay stop working.

## Pair a device

1. On the desktop, open **Settings → Pair a device** and show the QR code, or run `pimi daemon pair` for a link.
2. In the Android app, scan the code or open the `pimi://pair/#offer=…` link.
3. Keep the code private. It carries the daemon's public key and the session id.

Keep the desktop awake. While it sleeps the phone cannot reach it; the daemon reconnects to the relay within about 30 seconds of waking.

## Who can share one relay

One relay serves any number of computers. Each daemon gets its own session id, and each computer is paired separately. Friends can point their own daemons at your relay; the relay only sees encrypted frames, never their contents. Raise `PIMI_RELAY_MAX_SOCKETS_PER_IP` if several people share one network address.

Anyone who knows a session id can open a socket in it and replace the daemon's control socket, so the relay is only as available as that id is secret. The id is not a credential for the session contents, which stay behind the Noise handshake and the daemon key.
