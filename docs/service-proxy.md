# Service Proxy

Pimi proxies HTTP traffic to services running inside your chats. Localhost service URLs are always enabled; optional public aliases and a separate service-only listener can be layered on through config.

## How it works

When a `pimi.json` script of `"type": "service"` starts, Pimi assigns it a local port and registers a route in the service proxy. Incoming requests whose `Host` header matches the script's generated hostname are forwarded to that port. HTTP requests, WebSocket upgrades, and service health checks select the reachable IPv4 or IPv6 loopback address. Services can bind to `127.0.0.1` or `::1` without changing their proxy URL.

The generated hostname is built from the script name, branch, and project:

```
<script>--<branch>--<project>.localhost
```

If the branch is `main` or `master`, the branch segment is omitted:

```
<script>--<project>.localhost
```

**Example:** a script named `dev` in the `miniweb` project on branch `feature/auth` would be reachable at:

```
dev--feature-auth--miniweb.localhost
```

Local and public routes use one combined leftmost label (`script--branch--project`). This keeps the hostname compatible with normal single-level wildcard DNS and TLS. If the combined label would exceed DNS's 63-character label limit, Pimi truncates it with a deterministic hash suffix to avoid collisions.

## Managing scripts

Configured `pimi.json` scripts can be managed without addressing their backing terminal directly:

```bash
pimi script ls [--cwd <path> | --chat <chat-id>]
pimi script start <name> [--cwd <path> | --chat <chat-id>]
pimi script stop <name> [--cwd <path> | --chat <chat-id>]
```

The commands return the same script metadata shown by the chat: lifecycle, service port, proxy URLs, health, exit code, and supervised terminal ID. `stop` terminates the managed terminal rather than only removing the proxy route, so normal script lifecycle cleanup remains authoritative. MCP exposes matching `list_scripts`, `start_script`, and `stop_script` tools; those require an explicit chat ID.

## Configuration

Add a `serviceProxy` block under `daemon` in `~/.pimi/config.json`:

```json
{
  "version": 1,
  "daemon": {
    "serviceProxy": {
      "listen": "0.0.0.0:8080",
      "publicBaseUrl": "https://pimiapps.my.domain.com"
    }
  }
}
```

| Field           | Required | Description                                                                                                                                   |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen`        | No       | Starts a separate service-only listener at this address. If omitted, services are still reachable on the daemon listener via localhost hosts. |
| `publicBaseUrl` | No       | Adds public service host aliases and public service links. If omitted, links use localhost addresses only.                                    |

`enabled` is accepted for old configs but no longer enables a mode. `enabled: false` suppresses optional `listen`/`publicBaseUrl` layers only; localhost service proxying remains always enabled.

## DNS and reverse proxy setup

For generated URLs to be reachable, you need wildcard DNS pointing to the machine running the Pimi daemon.

**Example:** to expose services at `https://dev--miniweb.pimiapps.my.domain.com` where the daemon host is `10.1.1.1`:

1. Configure a wildcard DNS record:

   ```
   *.pimiapps.my.domain.com  →  10.1.1.1
   ```

2. Set `publicBaseUrl` to `https://pimiapps.my.domain.com` in your config.

3. If you put a reverse proxy (nginx, Caddy, Traefik, etc.) in front of Pimi, point it at either the daemon listener or the optional service-only listener and ensure it forwards the `Host` header unchanged. The proxy uses the `Host` header to route requests to the correct service — rewriting it will break routing.

Public service URLs expose the service itself. Daemon password authentication protects daemon APIs; it does not protect proxied dev services.

The daemon trusts forwarded headers from loopback proxies by default. If your proxy reaches the daemon from another address, configure the proxy ranges explicitly:

```json
{
  "version": 1,
  "daemon": {
    "trustedProxies": ["loopback", "172.16.0.0/12"]
  }
}
```

`PIMI_TRUSTED_PROXIES` accepts the same comma-separated values, for example `loopback,172.16.0.0/12`. Use `true` only when the final trusted proxy overwrites client-supplied `X-Forwarded-*` headers.

Nginx example:

```nginx
server {
    listen 443 ssl;
    server_name *.pimiapps.my.domain.com;

    location / {
        proxy_pass http://10.1.1.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Nginx's `$host` drops the port. If you terminate on a non-default port, use `$http_host` instead so the port survives — that is what "forwards the `Host` header unchanged" means here.

## Forwarded headers

Pimi sets these when it forwards a request to a chat service:

| Header              | Value                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Forwarded-Host`  | The `Host` header verbatim, including the port when the client used one                                                                 |
| `X-Forwarded-Proto` | The request scheme (`http` on the WebSocket upgrade path)                                                                               |
| `X-Forwarded-For`   | The immediate peer address. Replaces any existing chain, so behind your own reverse proxy this is the proxy's address, not the client's |
| `X-Forwarded-Port`  | The port from the `Host` header when it has one, otherwise whatever your proxy already set                                              |

`X-Forwarded-Port` follows the same trust rule as `X-Forwarded-Host`: the authority Pimi observed wins. When the `Host` header carries a port, that port is reported and replaces any inbound `X-Forwarded-Port`, so a client cannot forge one. When `Host` carries no port there is nothing to observe, so a value your reverse proxy set survives untouched — that is the case where nginx's `$host` drops the port and `X-Forwarded-Port` is the only source. Pimi never derives the port from the scheme. Any other `X-Forwarded-*` header your proxy sends is passed through untouched.

Services that build absolute URLs should prefer `Host` or `X-Forwarded-Host`.

### The forwarded authority is not authenticated

Route lookup normalizes the port away before matching a service hostname, so a client can address the daemon with any port in `Host` and still reach the service. That port is what lands in `X-Forwarded-Host` and `X-Forwarded-Port`. Pimi also does not check whether an inbound `X-Forwarded-Port` came from a proxy in `trustedProxies` — when `Host` carries no port, a client-supplied value is passed through.

Treat the forwarded authority as client-influenced input. A service that builds password reset links, absolute redirects, or cached URLs from it should pin its own public origin in configuration rather than deriving one from request headers. This is not specific to `X-Forwarded-Port`: the `Host` header has always carried a client-chosen port.

## Environment variables

The listen address and public base URL can also be set via environment variables, which take precedence over `config.json`:

| Variable                             | Description                                                               |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `PIMI_SERVICE_PROXY_ENABLED`         | Compatibility shim; `false` suppresses optional public/listen layers only |
| `PIMI_SERVICE_PROXY_LISTEN`          | Starts the optional service-only listener, e.g. `0.0.0.0:8080`            |
| `PIMI_SERVICE_PROXY_PUBLIC_BASE_URL` | Adds public service aliases and links                                     |
