# Vault

The vault lets an agent use a secret without being handed it. Secrets are never put in an agent's environment, never written to a timeline, and never returned by an RPC. An agent calls `vault_run` with a command and secret names; the daemon runs the command with the secrets in its environment and returns the output with the values removed.

Read [SECURITY.md](../SECURITY.md#local-daemon-trust-boundary) and [permissions.md](permissions.md) first. The vault is built on a hostile premise those docs state: agents run as your OS user, with no sandbox.

## Turning it on

The vault is off by default. Settings > Vault (under the Security group) has one setup card: passphrase twice, optionally Touch ID, one button. It sets `daemon.vault.enabled` in `config.json`, creates the vault and enrolls Touch ID, in that order; the later steps are separate RPCs, so a failure leaves the earlier ones in place and the page shows the next step. The chat's ⋯ menu always has a Vault item that opens the page (or the waiting request). Turning it on or off applies live, with no daemon restart. While it is off:

- Agents get no `vault_list` or `vault_run` tool and the system prompt never mentions the vault. A chat started before the switch changed keeps its tool list until it ends; its `vault_run` calls fail because turning the vault off locks it.
- Every `vault.*` request is refused with `vault_disabled`, and the app shows only the switch.
- The environment is not scrubbed and nothing is redacted: off means the vault file is ignored. Turning it on again removes the vault's variables from the daemon environment; variables already removed stay removed until the daemon restarts.
- `vault.json` and `audit.jsonl` are left as they are.

## Threat model

An agent can read `$PIMI_HOME/local-credential`, so it can connect to the daemon with full authority. The desktop app is ad-hoc signed with `hardenedRuntime` off (`packages/desktop/electron-builder.yml:96-98`), so the macOS keychain and Electron `safeStorage` would hand the same agent the key. That is why the vault is sealed with a passphrase you type, not a key the machine holds.

The one exception is Touch ID on the Mac, which holds the key in the Secure Enclave rather than the keychain (see [Touch ID](#touch-id)). The keychain and `safeStorage` stay unused.

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
- **A Touch ID prompt you did not start.** Any same-user process can start the helper or send `vault.quick_unlock.prove`, and the Mac then shows a real Touch ID prompt. If you touch it, the caller gets what the passphrase would give: a reflex touch is easier to give than a 12-character passphrase. The prompt names the process that asked and the dialog says what it is for; approve one only when you started it. It is opt-in for this reason.
- **Denial of service.** Anyone admitted can lock the vault, and repeated wrong passphrases from any client slow your own unlock attempts (see Passphrase attempts).

## Storage

`$PIMI_HOME/vault/vault.json` (mode 0600) holds one AES-256-GCM message with a fresh random 12-byte nonce on every write, under a key derived from your passphrase with scrypt. The KDF cost, the salt and the scrub list are the unencrypted header and are bound to the ciphertext as additional authenticated data, so editing them makes the next unlock fail. The key lives in daemon memory only. A restart locks the vault, and so does a period without use: `daemon.vault.idleLockMinutes` (15 by default; 60, 480, or 0 for "until the daemon restarts"). A longer period leaves decrypted secrets in daemon memory longer.

`$PIMI_HOME/vault/audit.jsonl` records unlocks, changes, approvals and runs: names, executables and exit codes, never values.

There is no reveal RPC. A value goes in with `vault.set_secret.request` and does not come back.

node's scrypt refuses `N=2^17, r=8` with its default 32 MiB `maxmem`. `crypto.ts` raises it from the parameters. If you change the cost, measure it on the slowest machine you support.

## Touch ID

Desktop only, opt-in, on a Mac with a Secure Enclave. `packages/desktop/native/mac-vault/VaultKey.swift` builds `pimi-vault-key` with the other desktop helpers (ad-hoc signed, no Developer ID, CryptoKit and LocalAuthentication only). The desktop app passes its path to the daemon as `PIMI_VAULT_KEY_HELPER`; without it (headless daemon, Linux, Windows, a dev daemon) `quickUnlock` reads `unavailable` and nothing shows.

Enrolling wraps the vault key to a Secure Enclave P-256 key made with `.userPresence` and stores the blob in `$PIMI_HOME/vault/quick-unlock.json` (0600) with the vault's KDF salt. The key never touches a keychain, which an ad-hoc binary cannot use (`-34018`). A process that copies the blob gets nothing without a touch or the Mac password. `vault.quick_unlock.prove` unwraps inside the daemon, then unlocks the vault or checks the key and marks the socket operator; the key never crosses the wire. A salt that no longer matches (vault recreated) or a key the Secure Enclave no longer has deletes the file.

The app shows the Touch ID button only in the desktop app on its own local daemon. The phone and plain web never show it, because the prompt would appear on a Mac you may not be at.

## Operator proof

Every WebSocket client the daemon admits has the same authority ([permissions.md](permissions.md)), except here. `vault.authorize.request` takes the passphrase and marks that socket as the operator for ten minutes. The mark is in memory, belongs to the physical socket, and ends on lock, reconnect or daemon restart. These need it: setting or deleting a secret or a grant, answering an approval request, importing environment variables, loading Bitwarden values. Unlocking and creating the vault prove the passphrase themselves.

Touch ID gives the same mark through `vault.quick_unlock.prove`. On the phone the card asks for the passphrase, or reads it from the device keystore behind Face ID or fingerprint (`expo-secure-store` with `requireAuthentication`; the stored passphrase lives in the phone's hardware keystore, out of reach of desktop agents).

The passphrase attempts of `unlock`, `authorize` and Touch ID share one budget across the daemon: five free tries, then a wait that doubles from one second to fifteen minutes. A blocked attempt does not run scrypt. A wrong passphrase says how many free tries are left.

## Environment scrubbing

Names the vault manages are deleted from the daemon's own `process.env` before anything can spawn, and again whenever a secret or an import adds one. Every child the daemon starts inherits from that environment, whether or not its spawn site knows about the vault, and an explicit provider overlay still wins because overlays apply on top. The desktop app removes the same names from the environment it launches the daemon with. The names are read from the vault header, so this works while the vault is locked.

Two consequences:

- The daemon loses those variables too. Config it read from the environment before bootstrap (speech API keys) is already captured. Anything that reads `process.env` later does not see them.
- Processes that were already running keep their environment. Restart agents after moving a variable in.

The environment list in the Vault page suggests names that look like credentials. Nothing moves without you selecting it.

## Blocked runs and approvals

`vault_run` resolves `argv[0]` to an absolute path through symlinks, then matches a grant on the executable, the leading arguments, the project and the secrets. Matching is string equality on argv elements; there is no glob and no shell.

A run that cannot proceed waits instead of failing and says what it waits for. One request per run carries `waitingFor`:

- `unlock`: the vault is locked. The request survives the lock; unlocking wakes the run.
- `approval`: no grant matches. Locking while it waits turns it back into an `unlock` request.
- `source`: a bound Bitwarden value is not loaded. Loading it wakes the run.

The three waits share the 30 second budget (`AGENT_WAIT_TIMEOUT_MS`). If you have not answered, the tool tells the agent to call again, and a call repeated with the same arguments joins the pending request. An "allow once" given after the first call gave up is kept for two minutes for that exact call. A vault that was never created fails at once; turning the vault off releases waiting runs with `disabled`.

The request is a card above the composer of the chat that owns it (a subagent's request shows in its panel and as one row in the parent), and in Settings > Vault. The card holds the proof step: Touch ID, or a passphrase field. Requests are not entries in the agent's `pendingPermissions`: agents can answer those with `respond_to_permission`, and a vault approval needs operator proof. The daemon raises attention for the chat through `AgentManager.raiseVaultAttention`, which reaches clients as `agent_attention_required` and phones as a push ("Needs the vault: <command>", subject to the push preview setting). It sets no unread state on the chat, so there is no sidebar dot; the toast, notification and card are the signals.

The card shows the exact argv, the folder relative to the project, the chat and the secret names.

## Bitwarden

Bitwarden secrets are read through your own `bw` CLI. Run `bw login` yourself; it needs your 2FA, SSO or device approval, which are interactive. In Sources, Unlock Bitwarden takes the master password once: the daemon passes it to `bw unlock --passwordfile` through a private temporary file that is removed as soon as `bw unlock` returns, runs `bw sync` (a failure is not fatal: it reads the CLI's local copy and says so), lists the items once, keeps a value-free index (id, name, username, field names) and copies the fields bound to vault secrets into memory, then runs `bw lock`. The index and the values live in daemon memory for 15 minutes and drop together, on lock, on Drop now and at the timer. Searching the picker reads the index; it asks for no password. The session key is never stored. `bw serve` is never started. Passkeys and TOTP codes are not supported.

A listing over 16 MiB fails with a message to bind by id. `bw status` is cached for 10 seconds and re-read by Check again.

Verified against `bw` 2026.11.1: not installed, signed out (`bw status` exit 0 with `unauthenticated`; other commands print their error on stdout and exit 1) and the error copy. Not verified: anything with a logged-in account, including `unlock` output, `sync`, the shape of `list items`, and whether `bw lock` ends a session you hold in another terminal (it clears the stored key, so assume it does).

## Apple Passwords, .env and CSV

Apple does not let other apps read saved passwords, with or without a Developer ID, so there is no live link. Settings > Vault offers a one-time copy: paste `.env` lines, or import the CSV the Passwords app exports (File > Export All Passwords to File). Both parse in the app and add secrets through `vault.set_secret`; there is no daemon file read. The export is not encrypted: delete it afterwards.

## Verify in the real app

Run the dev stack, never the daemon on port 6767, then:

1. Settings, Vault, create a vault. Add a secret with a distinctive value.
2. In a chat, ask the agent to `vault_list`, then run `printenv NAME` with the secret. Approve it. Check the output shows `[redacted:name]`.
3. Ask the agent to print the value base64-encoded. Check the output is still redacted.
4. Lock the vault. Check `vault_run` is refused.
5. Quit and restart the daemon. Check the vault is locked.
6. Run `ps eww` and `env` in a terminal inside Pimi. Check the value is absent.
7. Edit `vault.json` by hand. Check unlock fails.
