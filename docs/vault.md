# Vault

The vault lets an agent use a secret without being handed it. Secrets are never put in an agent's environment, never written to a timeline, and never returned by an RPC. An agent calls `vault_run` with a command and secret names; the daemon runs the command with the secrets in its environment and returns the output with the values removed.

Read [SECURITY.md](../SECURITY.md#local-daemon-trust-boundary) and [permissions.md](permissions.md) first. The vault is built on a hostile premise those docs state: agents run as your OS user, with no sandbox.

## Turning it on

The vault is off by default. Settings > Vault (under the Security group) has the switch, and the chat's ⋯ menu always has a Vault item that opens it (or the waiting request); it is `daemon.vault.enabled` in `config.json` and applies live, with no daemon restart. While it is off:

- Agents get no `vault_list` or `vault_run` tool and the system prompt never mentions the vault. A chat started before the switch changed keeps its tool list until it ends; its `vault_run` calls fail because turning the vault off locks it.
- Every `vault.*` request is refused with `vault_disabled`, and the app shows only the switch.
- The environment is not scrubbed and nothing is redacted: off means the vault file is ignored. Turning it on again removes the vault's variables from the daemon environment; variables already removed stay removed until the daemon restarts.
- `vault.json` and `audit.jsonl` are left as they are.

## Threat model

An agent can read `$PIMI_HOME/local-credential`, so it can connect to the daemon with full authority. The desktop app is ad-hoc signed with `hardenedRuntime` off (`packages/desktop/electron-builder.yml:96-98`), so the macOS keychain and Electron `safeStorage` would hand the same agent the key. That is why the vault is sealed with a passphrase you type, not a key the machine holds.

Phase 1 aims at two things:

- Secrets are not handed to agents by default: not in the environment, the timeline, tool output, or a plaintext file.
- An agent cannot give itself a secret. Adding secrets, approving commands and changing grants need the passphrase, and an agent does not have it.

## What it does not protect against

Do not rely on the vault for any of these.

- **Abuse through an approved command.** A grant for `gh api` lets an agent call any `gh api` endpoint with the token. A grant with no fixed arguments lets it pass any. A grant for an interpreter or build tool (`npm`, `make`, `python`, `sh`, `terraform`) lets any code in the project use the secret, and the UI warns on these. A grant also covers whatever sits at that path later: a binary an agent replaces keeps the grant.
- **Secrets that are still elsewhere.** A value in `~/.zshrc`, a `.env` file, `~/.aws` or `~/.config` is readable by the agent. Moving a variable into the vault removes it from the environment Pimi launches with, and a login shell in a Pimi terminal reads your rc files again. Remove it from those files too.
- **The provider key the agent CLI needs.** Claude Code, Codex and the others need their own API credentials to run. Hiding `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from agents breaks them, so do not.
- **Transformed output.** The redactor matches the value and these encodings of it: base64 (all three alignments), base64url, hex, URL-encoded and JSON-escaped. A program that reverses, splits, hashes or encrypts the value before printing it defeats the redactor. Values shorter than eight characters are not registered; the UI marks them "Not redacted".
- **Output Pimi does not see first.** An agent's own shell tool runs outside `vault_run`. What it prints reaches the timeline unredacted, except for values the vault already knows, which the timeline redactor removes while the vault is unlocked.
- **Driving Pimi itself.** An agent can install a plugin, attach a debugger to the daemon, drive the desktop UI or read the daemon's memory. All of these run as the same user. The passphrase is typed in the app, and a plugin or a debugger can watch it being typed.
- **Deleting or rolling back the vault file.** Anyone who can write `$PIMI_HOME/vault/vault.json` can delete it or restore an older copy. Edits to the file are detected when you unlock; removal and rollback are not.
- **Offline guessing.** A same-user process can copy `vault.json` and try passphrases against it. The key derivation (scrypt, 128 MiB, about half a second a guess here) slows this down; a weak passphrase still loses.
- **Processes that already hold the value.** A program started with a secret keeps it until it exits. A grandchild it leaves behind can outlive `vault_run`'s timeout, because `execFile` cannot put a program in its own process group.
- **Live terminal streams.** The redactor runs on `capture_terminal` results, `vault_run` output, timeline rows and stream events. It does not run on live PTY streams to the app.
- **The daemon log.** Vault code never logs a value. The log is not passed through the redactor, so a value an agent prints can appear in trace-level event logs only where that event did not go through the timeline path.
- **Metadata.** Secret names, environment variable names, descriptions, grants and the audit log are readable by any admitted client, including an agent connecting over the WebSocket. The scrub list is stored unencrypted in the vault header, because the daemon needs it before anything unlocks.
- **A locked vault does not redact.** Redaction only knows values while the vault is unlocked. Nothing can run with a secret while it is locked.
- **Denial of service.** Anyone admitted can lock the vault, and repeated wrong passphrases from any client slow your own unlock attempts (see Passphrase attempts).

## Storage

`$PIMI_HOME/vault/vault.json` (mode 0600) holds one AES-256-GCM message with a fresh random 12-byte nonce on every write, under a key derived from your passphrase with scrypt. The KDF cost, the salt and the scrub list are the unencrypted header and are bound to the ciphertext as additional authenticated data, so editing them makes the next unlock fail. The key lives in daemon memory only. A restart locks the vault, and so does 15 minutes without use.

`$PIMI_HOME/vault/audit.jsonl` records unlocks, changes, approvals and runs: names, executables and exit codes, never values.

There is no reveal RPC. A value goes in with `vault.set_secret.request` and does not come back.

node's scrypt refuses `N=2^17, r=8` with its default 32 MiB `maxmem`. `crypto.ts` raises it from the parameters. If you change the cost, measure it on the slowest machine you support.

## Operator proof

Every WebSocket client the daemon admits has the same authority ([permissions.md](permissions.md)), except here. `vault.authorize.request` takes the passphrase and marks that socket as the operator for ten minutes. The mark is in memory, belongs to the physical socket, and ends on lock, reconnect or daemon restart. These need it: setting or deleting a secret or a grant, answering an approval request, importing environment variables, loading Bitwarden values. Unlocking and creating the vault prove the passphrase themselves.

The passphrase attempts of `unlock` and `authorize` share one budget across the daemon: five free tries, then a wait that doubles from one second to fifteen minutes. A blocked attempt does not run scrypt.

## Environment scrubbing

Names the vault manages are deleted from the daemon's own `process.env` before anything can spawn, and again whenever a secret or an import adds one. Every child the daemon starts inherits from that environment, whether or not its spawn site knows about the vault, and an explicit provider overlay still wins because overlays apply on top. The desktop app removes the same names from the environment it launches the daemon with. The names are read from the vault header, so this works while the vault is locked.

Two consequences:

- The daemon loses those variables too. Config it read from the environment before bootstrap (speech API keys) is already captured. Anything that reads `process.env` later does not see them.
- Processes that were already running keep their environment. Restart agents after moving a variable in.

The environment list in the Vault page suggests names that look like credentials. Nothing moves without you selecting it.

## Approvals

`vault_run` resolves `argv[0]` to an absolute path through symlinks, then matches a grant on the executable, the leading arguments, the project and the secrets. Matching is string equality on argv elements; there is no glob and no shell. With no grant it files a request and waits 30 seconds (`AGENT_WAIT_TIMEOUT_MS`). If you have not answered, the tool tells the agent to call again. A call repeated with the same arguments joins the pending request, and an "allow once" given after the first call gave up is kept for two minutes for that exact call.

The approval card shows the exact argv, the working directory, the agent and the secret names.

## Bitwarden

Bitwarden secrets are read through your own `bw` CLI. Run `bw login` yourself. On the Vault page you type the master password; the daemon passes it to `bw unlock --passwordfile` through a private temporary file that is removed as soon as `bw unlock` returns, copies the fields bound to vault secrets into memory for 15 minutes, and runs `bw lock`. The session key is never stored. `bw serve` is never started. Passkeys and TOTP codes are not supported.

This source was written without `bw` installed. The flags follow the Bitwarden CLI documentation and have not been run against the real CLI. The Bitwarden section needs a pass with a real account before you rely on it.

## Verify in the real app

Run the dev stack, never the daemon on port 6767, then:

1. Settings, Vault, create a vault. Add a secret with a distinctive value.
2. In a chat, ask the agent to `vault_list`, then run `printenv NAME` with the secret. Approve it. Check the output shows `[redacted:name]`.
3. Ask the agent to print the value base64-encoded. Check the output is still redacted.
4. Lock the vault. Check `vault_run` is refused.
5. Quit and restart the daemon. Check the vault is locked.
6. Run `ps eww` and `env` in a terminal inside Pimi. Check the value is absent.
7. Edit `vault.json` by hand. Check unlock fails.
