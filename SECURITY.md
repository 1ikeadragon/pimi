# Security

Pimi runs a daemon on your machine to manage coding agents. The desktop app, mobile app, and CLI connect to that daemon. Pimi stores workspace data locally. Configured AI providers and integrations can receive data when you use them.

## Architecture

The daemon can run wherever you execute agents, including a laptop, Mac mini, VPS, or container.

Clients connect to the daemon over WebSocket. There are two ways to establish this connection:

- **Relay connection** — When you enable remote pairing, the daemon connects outbound to the configured relay. No open ports required.
- **Direct connection** — The daemon listens on a network address and clients connect directly.

## Relay threat model

The relay is designed to be untrusted. All traffic between your phone and daemon is end-to-end encrypted. The relay server cannot read your messages, see your code, or modify traffic without detection. Even if the relay is compromised, your data remains protected.

### How it works

1. The daemon generates a persistent Curve25519 keypair on first run and stores it at `$PASEO_HOME/daemon-keypair.json` with mode `0600`
2. The pairing URL carries the daemon's public key in its `#offer=` fragment. Pimi uses `pimi://pair/#offer=...` by default. You can scan it in the app or paste it into Add Host without visiting a website.
3. When the phone connects via the relay, it generates fresh ephemeral keys and sends an `e2ee_hello` message. The daemon will not process any application messages until this handshake completes.
4. Updated peers run a Noise `NK` handshake (`Noise_NK_25519_ChaChaPoly_SHA256`) keyed to the daemon's static key: the `e2ee_hello` carries the first Noise message and the daemon's `e2ee_ready` carries the second. Every later frame is a counter-nonced ChaCha20-Poly1305 record. When either side predates this, the session falls back to the legacy construction: a Curve25519 ECDH shared key with XSalsa20-Poly1305 (NaCl `box`) and a random `[24-byte nonce][ciphertext]` bundle. Both modes negotiate `binaryCiphertext`: negotiated application text is carried as a base64 WebSocket text frame, while application binary is carried as a raw WebSocket binary frame. A peer that does not negotiate the capability uses base64 text frames for both kinds. [docs/relay-endpoint-security.md](docs/relay-endpoint-security.md) has the exact mapping.

The WebSocket opcode is preserved end to end after negotiation; the receiver never guesses whether authenticated plaintext is text or binary from its byte contents. The plaintext handshake remains WebSocket text and contains only public keys and capability declarations.

The relay sees only: IP addresses, timing, message sizes, session IDs, and the plaintext `e2ee_hello` / `e2ee_ready` handshake frames (which contain only public keys). It cannot read message contents, forge messages, or derive encryption keys from observing the handshake.

### Why the relay can't attack you

The daemon requires a valid cryptographic handshake before processing any commands. A compromised relay cannot:

- **Impersonate the daemon to your phone** — Without the daemon's secret key, it cannot derive the shared key, so any traffic it injects fails authenticated decryption on the phone
- **Inject commands into an authenticated connection** — The daemon only accepts traffic that decrypts and authenticates under that connection's keys. Someone with the pairing link can open their own connection, so configure a daemon password to authenticate remote users.
- **Read your traffic** — After the handshake every message is encrypted: ChaCha20-Poly1305 in protected mode, XSalsa20-Poly1305 (NaCl box) in legacy mode
- **Forge messages** — Both constructions are authenticated encryption; a tampered message is rejected in either mode
- **Replay old messages** — In protected mode the daemon contributes a fresh ephemeral key to every session and every record carries a strictly increasing counter, so a recorded session cannot be replayed into a new one and a duplicated, reordered, or reflected record closes the session. Pimi requires protected mode by default. Setting `daemon.relay.requireProtectedSecurity: false` admits legacy clients, whose recorded sessions can be replayed.

### Trust model

Keep the pairing QR code and link private. Anyone with the link can control a passwordless daemon over the relay. Use a separate daemon password for remote access.

When a daemon password is configured, relay clients send it in the encrypted `hello` message, so the relay never sees it. The daemon rejects a relay client that sends a wrong password or none, so a leaked pairing link alone does not grant access to a password-protected daemon.

## Network activity

Relay pairing and provider quota polling are opt-in. Pimi checks GitHub for desktop releases when automatic updates are enabled. Voice model downloads start when you request them in Settings.

Remote Markdown images appear as links. Loading a Spaces preview sends the saved video, post, or paper ID to its publisher. The desktop app uses a separate session for those previews and strips cookies and credentials from their requests. Android scans pairing QR codes on-device and ships without the Google scanner and Firebase push stack.

### Provider traffic

Pimi disables Claude Code metrics, error reports, quality surveys, and automatic marketplace installation. Standard Codex and Copilot launches disable built-in client telemetry, and Copilot launches also disable session history sync to GitHub. Custom Codex and Copilot launch commands and explicitly configured exporters use their own settings. Model requests still go to the provider you select and follow that provider's data policy.

## Local daemon trust boundary

By default, the daemon binds to `127.0.0.1`. With no password configured, anything that can reach the daemon socket can control the daemon. Loopback is reachable by other users on the machine and by some forwarding tools.

The daemon supports an optional shared-secret password (set via `auth.password` in `config.json` or the `PASEO_PASSWORD` env var; stored bcrypt-hashed). WebSocket clients send the password in `hello`; the daemon sends no session data before admission. Direct connections still accept bearer headers and WebSocket bearer subprotocols for older clients. HTTP stays bearer-header based. Health (`GET /api/health`) and CORS preflight (`OPTIONS`) are exempt; `/api/files/download` and `/mcp/agents` use their own capability tokens.

The daemon writes a new `$PASEO_HOME/local-credential` on every run with mode `0600` and removes it on shutdown. The CLI and desktop main process read it only for the daemon whose PID lock `listen` matches their connection target. A same-user process can read this credential, so the password protects against network clients and other OS users, not processes running as the daemon user. Protect `$PASEO_HOME` accordingly. Relay traffic remains end-to-end encrypted independently of password admission.

Connected clients are trusted operators of the daemon user. File previews follow that authority: a preview request may read any regular file the daemon process can read, while keeping path normalization and symlink checks in the daemon file service. Workspace-relative paths remain a UI convenience, not a security boundary.

When Paseo checks out a change request from a different repository, it does not run that workspace's `paseo.json` setup, automatic terminals, named scripts, or teardown until you explicitly run setup for that workspace. The decision lasts for the workspace and does not re-prompt after new commits. Same-repository changes, ordinary branches, local workspaces, agent launches, terminals, explicit shell commands, and metadata-generation instructions are outside this gate.

If you expose the daemon beyond loopback, such as by binding to `0.0.0.0`, forwarding it through a tunnel or reverse proxy, or publishing it from a Docker container, you are responsible for restricting and securing that access. Setting a password is strongly recommended in that case.

In Docker, the official image runs the daemon and agents as the non-root
`paseo` user by default. Mounted workspaces and credentials are still fully
available to anything the agents run inside the container.

For remote access, use the relay connection. It is the supported path for reaching the daemon off-machine, and it adds end-to-end encryption plus a pairing handshake before commands are accepted.

Host header validation and CORS origin checks are defense-in-depth controls for localhost exposure. They help block DNS rebinding and browser-based attacks, but they do not replace network isolation.

## DNS rebinding protection

CORS is not a complete security boundary. It controls which browser origins can make requests, but does not prevent a malicious website from resolving its domain to your local machine (DNS rebinding).

Paseo validates the `Host` header on every HTTP request and every WebSocket upgrade against an allowlist (Vite-style semantics). By default, only `localhost`, `*.localhost`, and any literal IP address (IPv4 or IPv6) are accepted. Additional hostnames can be configured via `hostnames` in `config.json` or the `PASEO_HOSTNAMES` env var (comma-separated; entries beginning with `.` match a domain and its subdomains; the value `true` disables the allowlist entirely). Requests with unrecognized hosts are rejected with `403 Host not allowed`.

## HTML file preview

The preview can run a file’s inline scripts inside a sandbox. Its content security policy blocks remote subresources, forms, nested frames, and network APIs. Pimi Desktop blocks a preview’s attempts to navigate in the Electron main process. Android disables WebView network loads in native code.

In a regular web browser, a preview can still navigate its own frame to an external URL. This can send data available inside the preview, such as its own contents and your IP address. Use **Source** to read HTML without running it.

## Agent authentication

Paseo wraps agent CLIs (Claude Code, Codex, OpenCode) but does not manage their authentication. Each agent provider handles its own credentials. Paseo never stores or transmits provider API keys. Agents run in your user context with your existing credentials.

## Forge host trust

Paseo only talks to a forge host that is either a known cloud host or one the forge CLI is already authenticated to. It never probes or routes credentials to an unauthenticated, remote-derived host.

## Reporting vulnerabilities

For a Pimi vulnerability, contact the maintainer privately using the contact links on the [Pimi site](https://1ikeadragon.github.io/pimi/). Keep vulnerability details out of public issues.
