# Self-hosted relay

`packages/relay/src/node-relay.ts` is a Node server that speaks the Pimi relay protocol (v2). Run it when you want remote access through a box you control. The relay stays untrusted: it pipes opaque frames by session id, and the daemon and client secure the session end to end ([relay-endpoint-security.md](relay-endpoint-security.md)).

## Behavior

- Protocol version 2 only. A missing or `v=1` request gets HTTP 400.
- A plain `GET /ws` without an upgrade returns 426 before the query is validated.
- A daemon data socket that was replaced no longer closes the client sockets when the old one finishes closing.
- Every daemon socket (`role=server`) must carry `Authorization: Bearer <token>`. The first token a serverId presents is bound to it; a missing or different token gets HTTP 401. See [relay-endpoint-security.md](relay-endpoint-security.md#relay-registration).
- Only the serverId-to-token-hash bindings persist, in `$STATE_DIRECTORY/servers.json` (systemd `StateDirectory=`) or `PIMI_RELAY_REGISTRY_FILE`. With neither set they live in memory, and after a restart any daemon can claim any serverId first: run that way only for development. Bindings unused for 180 days are dropped on start; a daemon locked out after that can reset its pairing. An unreadable or malformed file stops the relay rather than reopening every serverId.
- Sessions, buffered frames, and counters live in memory and vanish on restart; daemons and clients reconnect on their own.

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
| `PIMI_RELAY_MAX_REGISTERED_SERVERS`            | serverId bindings kept (100000), then HTTP 503 for new daemons                                   |
| `PIMI_RELAY_MAX_REGISTRATIONS_PER_IP_PER_HOUR` | New serverId bindings per IP per hour (10), then HTTP 429                                        |

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
StateDirectory=pimi-relay
StateDirectoryMode=0700
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

## Android push (optional)

`pimi-push` is a separate process from the relay. It holds the only Firebase service-account key and calls Google, which the relay's sandbox (`IPAddressDeny=any`) must never do. Terminal pushes, and agent pushes to phones with previews off, carry the terminal or chat name (at most 80 characters) and a fixed body ("An agent finished."); that name passes through Google. For phones with previews on, the daemon sends only an AES-256-GCM sealed blob (`enc`, at most 1600 characters). The service forwards it as a data-only FCM message without reading or logging it, so neither it nor Google sees the chat name or message. Send bodies can reach 3 KB; the Caddy 4 KB cap below already covers that. A daemon that sends `enc` to an older `pimi-push` gets 400 `unknown_field` and loses that push, so redeploy `push-service.mjs` before updating daemons.

Build it with `npm run build:node-relay`, which also writes `packages/relay/dist-node/push-service.mjs`. Create a Firebase project with Cloud Messaging, then a service account whose custom role holds only `cloudmessaging.messages.create`. Copy its key to the server as `/etc/pimi-push/fcm-sa.json`, owner root, mode 600. Keep it out of the repo and out of backups you share.

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin pimi-push
install -d -m 755 /opt/pimi-push
install -m 644 push-service.mjs /opt/pimi-push/push-service.mjs
install -d -m 700 /etc/pimi-push   # then place fcm-sa.json here, mode 600
```

`/etc/systemd/system/pimi-push.service`. `LoadCredential` hands the key to the service without making it readable by the `pimi-push` user, and `StateDirectory` owns the handle store:

```ini
[Unit]
Description=Pimi push service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pimi-push
Group=pimi-push
ExecStart=/usr/bin/node /opt/pimi-push/push-service.mjs
LoadCredential=fcm-sa.json:/etc/pimi-push/fcm-sa.json
StateDirectory=pimi-push
StateDirectoryMode=0700
Environment=PIMI_PUSH_HOST=127.0.0.1
Environment=PIMI_PUSH_PORT=8788
Environment=PIMI_PUSH_STORE=/var/lib/pimi-push/handles.json
Restart=always
RestartSec=2

NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
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
RestrictAddressFamilies=AF_INET AF_INET6
UMask=0077
MemoryMax=512M
TasksMax=128

[Install]
WantedBy=multi-user.target
```

Unlike the relay, this unit may reach the internet (`oauth2.googleapis.com`, `fcm.googleapis.com`); the service hardcodes both hosts, ignores the key file's `token_uri`, and refuses redirects. The service reads the key from `$CREDENTIALS_DIRECTORY/fcm-sa.json` when `PIMI_PUSH_SERVICE_ACCOUNT` is unset.

In the Caddyfile add a `/push/*` block with a small body cap **before** the catch-all `handle`. Registration bodies are under 1 KB and send bodies under 3 KB:

```
relay.example.com {
	handle /ws {
		reverse_proxy 127.0.0.1:8787
	}
	handle /health {
		reverse_proxy 127.0.0.1:8787
	}
	handle /push/* {
		request_body {
			max_size 4KB
		}
		reverse_proxy 127.0.0.1:8788
	}
	handle {
		respond "Not found" 404
	}
}
```

The service rate-limits per client IP (and per FCM token for sends). It takes the IP from the **last** `X-Forwarded-For` entry, and only when the request comes from loopback. Caddy appends the peer it sees. Behind Cloudflare that peer is a Cloudflare address, so every client would share one budget: use the `relay_proxy` snippet from [Behind Cloudflare](#behind-cloudflare) for `/push/*` too, so `X-Forwarded-For` is replaced with `CF-Connecting-IP` for Cloudflare peers. Without it, one noisy client can exhaust everyone's limit.

Phones pin the push origin when the APK is built: `EXPO_PUBLIC_PIMI_PUSH_ENDPOINT` (default `https://relay.stateless.computer/push`) is baked into the bundle, together with `PIMI_ANDROID_GOOGLE_SERVICES_FILE` for the matching Firebase project. A daemon can advertise a different push URL, but the app then skips push instead of sending its token there. A self-hosted push service therefore needs your own APK build. The daemon advertises `https://<relay>/push` while the relay is enabled; set `PIMI_PUSH_ENDPOINT` to override.

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

1. On the desktop, open **Settings → Host → Pair a device** and show the QR code, or run `pimi daemon pair` for a link.
2. In the Android app, scan the code or open the `pimi://pair/#offer=…` link.
3. Keep the code private. It carries the daemon's public key and the session id.

Keep the desktop awake. While it sleeps the phone cannot reach it; the daemon reconnects to the relay within about 30 seconds of waking.

## Who can share one relay

One relay serves any number of computers. Each daemon gets its own session id, and each computer is paired separately. Friends can point their own daemons at your relay; the relay only sees encrypted frames, never their contents. Raise `PIMI_RELAY_MAX_SOCKETS_PER_IP` if several people share one network address.

Anyone who knows a session id can open a socket in it and replace the daemon's control socket, so the relay is only as available as that id is secret. The id is not a credential for the session contents, which stay behind the Noise handshake and the daemon key.
