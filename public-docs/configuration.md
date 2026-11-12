---
title: Configuration
description: Configure managed instances and foreground deployments.
nav: Configuration
order: 40
category: Configuration
---

# Configuration

Managed instances load their configuration from the home’s `config.json` and defaults. Foreground deployments can override that file with environment variables.

## Where config lives

By default, Pimi uses `~/.pimi` as its home directory. The configuration file is:

```bash
~/.pimi/config.json
```

You can change the home directory by setting `PIMI_HOME` or selecting `--home` on a CLI command.

## Precedence

Managed `start` and Desktop use defaults, then `config.json`. Inherited daemon-setting environment variables are removed from their launches.

Foreground `pimi daemon run`, Docker, and direct supervisor launches apply environment variables after the file. Existing legacy supervisor flags retain their precedence across worker restart. Changing deployment overrides requires stopping and relaunching that deployment. Lists append across sources, including hostnames and CORS origins.

## Example

Minimal example that configures listening address, hostnames, and MCP:

```json
{
  "$schema": "https://github.com/1ikeadragon/pimi/blob/main/README.md.config.v1.json",
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:6767",
    "hostnames": ["localhost", ".localhost"],
    "mcp": { "enabled": true }
  }
}
```

`daemon.hostnames` is the primary field. The old `daemon.allowedHosts` name still works as a deprecated alias for backward compatibility.

## Apply changes

Edit the selected file through the CLI:

```bash
pimi daemon config get daemon.listen --home ~/pimi-test
pimi daemon config set daemon.listen 127.0.0.1:6800 --home ~/pimi-test
pimi daemon config unset daemon.relay.enabled --home ~/pimi-test
```

`get [path]` reports configured values and labels missing fields unset. It does not create a home. `set` parses JSON, otherwise treats the input as a string; `--string` forces a literal string. `--json` selects output format. Use whole-object JSON for dynamic keys containing dots. Unknown paths, invalid values, and invalid existing files are rejected without writing. Passwords use `set-password`.

A successful edit saves the validated file, then reloads once if the instance is reachable. Output distinguishes applied changes, restart requirements, and deployment overrides. A stopped/unbound/unreachable instance reports **saved; not applied**. A failed reload reports **saved; reload failed** with a nonzero exit; the file remains saved. Edits never implicitly restart.

After editing `config.json` directly, reload it:

```bash
pimi reload
```

The daemon validates the complete file before applying anything. It applies runtime-safe changes and lists any settings that still need a restart. If it reports restart-required paths, run:

```bash
pimi daemon restart
```

Runtime-safe settings include relay enablement, MCP settings, browser tools, hostnames, CORS origins, trusted proxies, Git process limits, agent and terminal profiles, provider definitions, metadata generation, the app base URL, provider catalog timeout, and the global plugin switch. Removing one of these settings applies its omitted-field behavior; removing a provider removes it from future launches.

Relay stays off when you remove `daemon.relay.enabled`. Set `daemon.relay.endpoint` and restart to configure the relay address.

Idle runtime cleanup, listen addresses, authentication, relay endpoints and TLS, worktree allocation, service-proxy addresses, logging, speech, voice, credentials, and local model settings require a restart. Reload applies other valid edits in the same file before reporting those paths.

Deployment environment variables and legacy supervisor flags remain authoritative. Reload reports a changed file setting under `overrideControlledPaths` when a launch override prevents it from taking effect. This includes startup settings such as listen addresses, passwords, relay endpoints and TLS, service-proxy settings, logging, speech, and voice configuration. List settings such as hostnames and CORS origins still append across sources, so values from `config.json` continue to apply. Stop and relaunch the deployment without the override to make the file value authoritative.

## Agent providers

Agent providers, both the first-class ones Pimi ships with and custom entries you add under `agents.providers`, are documented on their own page.

See [Providers](/docs/providers) for the mental model and [Supported providers](/docs/supported-providers) for the full list of agents Pimi can launch. For pointing Claude at Anthropic-compatible endpoints (Z.AI, Alibaba/Qwen), multiple profiles, custom binaries, ACP agents, and the `additionalModels` merge behavior, see [Custom providers](/docs/custom-providers). The full field reference lives on GitHub at [docs/custom-providers.md](https://github.com/1ikeadragon/pimi-releases/blob/main/docs/custom-providers.md).

## Idle runtimes

Pimi releases resumable idle agent processes after one hour when its daemon baseline allows
cleanup and any implemented provider check agrees. Your next prompt resumes the same conversation. Disable this
for the entire host by turning off **Release idle agents** in **Settings → your host → Agents**, or with:

```json
{ "agents": { "idleRuntimeCleanup": false } }
```

This setting defaults to `true`. Changes in Settings apply immediately; config-file edits apply
on config reload. Re-enabling keeps existing idle timestamps. There is no per-agent setting. Providers without a runtime safety check use the same daemon baseline and one-hour idle
period. Active work, descendants and pending finish notifications prevent cleanup. ACP adapters
also retain runtimes with running ACP terminals, including silent ones; exited terminals do not
prevent cleanup. This check does not inspect processes launched internally by the provider.

## Worktrees

New worktrees are created under `$PIMI_HOME/worktrees` by default. To place new worktrees somewhere else, set `worktrees.root`:

```json
{
  "worktrees": {
    "root": "/mnt/fast/pimi-worktrees"
  }
}
```

Relative paths are resolved against `PIMI_HOME`. Existing worktrees remain where they are; changing this setting only changes where Pimi creates and discovers Pimi-managed worktrees going forward.

## Voice

Voice is configured through `features.dictation` and `features.voiceMode`. Provider credentials and options live inline at `features.dictation.stt`, `features.voiceMode.stt`, and `features.voiceMode.tts`.

For voice philosophy, architecture, and complete local/OpenAI setup examples, see [Voice docs](/docs/voice).

## Logging

Daemon logging uses separate console and file sinks by default:

- Console: `info` and above
- File (`$PIMI_HOME/daemon.log`): `trace` and above
- File rotation: `10m` max file size, `3` rotated files kept alongside the active file

```json
{
  "log": {
    "console": {
      "level": "info",
      "format": "pretty"
    },
    "file": {
      "level": "trace",
      "path": "daemon.log",
      "rotate": {
        "maxSize": "10m",
        "maxFiles": 3
      }
    }
  }
}
```

Legacy fields `log.level` and `log.format` are still supported and map to the new destination settings.

## Password authentication

You can require a password to connect to the daemon. When set, all HTTP and WebSocket clients must authenticate. Only the `/api/health` liveness endpoint is exempt, so that process supervisors and load balancers can probe without credentials.

The easiest way to set a password is with the CLI:

```bash
pimi daemon set-password
```

This prompts for a password, writes the bcrypt hash to `config.json`, and tells you to restart the daemon. Authentication is a startup setting, so `pimi reload` will also report it as restart-required.

Alternatively, set the `PIMI_PASSWORD` environment variable (plaintext, hashed automatically at startup):

```bash
PIMI_PASSWORD=my-secret pimi daemon start
```

Or write the hash directly in `config.json`:

```json
{
  "daemon": {
    "auth": {
      "password": "$2b$12$..."
    }
  }
}
```

After setting a password, restart the daemon for the change to take effect.

### Connecting with a password

The CLI picks up a password from, in order:

1. The `password` query parameter on a `tcp://` host URI:

   ```bash
   pimi --host "tcp://192.168.1.10:6767?password=my-secret" ls
   ```

2. The `PIMI_PASSWORD` environment variable, used as a fallback when the host carries no embedded password (works for `localhost:6767`, bare `host:port`, or `tcp://` hosts without a `password=` query):

   ```bash
   PIMI_PASSWORD=my-secret pimi ls
   PIMI_PASSWORD=my-secret pimi --host 192.168.1.10:6767 ls
   ```

A `password=` in the URI always wins over the env var, so you can keep `PIMI_PASSWORD` set globally and still target a different daemon by spelling its password into the URI.

In the mobile app, enter the password in the direct connection setup screen.

## Relay

Relay pairing requires a configured endpoint. Run [Pimi Relay](https://github.com/1ikeadragon/pimi-releases/blob/main/docs/self-hosted-relay.md) and add its address to `config.json`. Set `enabled` to `true` to turn it on at startup.

```json
{
  "daemon": {
    "relay": {
      "enabled": true,
      "endpoint": "relay.example.com:443",
      "useTls": true
    }
  }
}
```

Restart the daemon after changing the endpoint. See [Connectivity](./connectivity.md) for direct connections over a VPN and [Security](../SECURITY.md) for the relay encryption model.

## Common env vars

- `PIMI_HOME`, set Pimi home directory
- `PIMI_HOST`, set the daemon target for CLI commands
- `PIMI_PASSWORD`, on the daemon, the password to require (plaintext, hashed at startup); on the CLI, the password used to connect when the host URI doesn't include one
- `PIMI_LISTEN`, override `daemon.listen`
- `PIMI_RELAY_ENABLED`, enable or disable the outbound relay for this daemon launch
- `PIMI_HOSTNAMES`, override/extend `daemon.hostnames`
- `PIMI_ALLOWED_HOSTS`, deprecated alias for `PIMI_HOSTNAMES`
- `PIMI_TRUSTED_PROXIES`, configure trusted reverse proxy ranges for `X-Forwarded-*` headers
- `PIMI_LOG_CONSOLE_LEVEL`, override `log.console.level`
- `PIMI_LOG_FILE_LEVEL`, override `log.file.level`
- `PIMI_LOG_FILE_PATH`, override `log.file.path`
- `PIMI_LOG_FILE_ROTATE_SIZE`, override `log.file.rotate.maxSize`
- `PIMI_LOG_FILE_ROTATE_COUNT`, override `log.file.rotate.maxFiles`
- `PIMI_LOG`, `PIMI_LOG_FORMAT`, legacy log overrides (still supported)
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, fallback speech credentials and base URL when neither a site value nor an endpoint env value is set
- `OPENAI_STT_API_KEY`, `OPENAI_STT_BASE_URL`, speech-to-text key and base URL fallbacks when no value is saved at the dictation or voice-mode STT site
- `OPENAI_TTS_API_KEY`, `OPENAI_TTS_BASE_URL`, text-to-speech key and base URL fallbacks when no value is saved at the voice-mode TTS site
- `PIMI_VOICE_LLM_PROVIDER`, override voice LLM provider (`claude`, `codex`, `opencode`)
- `PIMI_DICTATION_STT_PROVIDER`, `PIMI_VOICE_STT_PROVIDER`, `PIMI_VOICE_TTS_PROVIDER`, override voice provider selection (`local` or `openai`)
- `PIMI_LOCAL_MODELS_DIR`, control local model directory
- `PIMI_DICTATION_LOCAL_STT_MODEL`, override local dictation STT model
- `PIMI_VOICE_LOCAL_STT_MODEL`, `PIMI_VOICE_LOCAL_TTS_MODEL`, override local voice STT/TTS models
- `PIMI_DICTATION_LANGUAGE`, `PIMI_VOICE_LANGUAGE`, override dictation and voice STT language
- `PIMI_VOICE_LOCAL_TTS_SPEAKER_ID`, `PIMI_VOICE_LOCAL_TTS_SPEED`, optional local voice TTS tuning

## Schema

For editor autocomplete/validation, set `$schema` to:

```
https://github.com/1ikeadragon/pimi/blob/main/README.md.config.v1.json
```
