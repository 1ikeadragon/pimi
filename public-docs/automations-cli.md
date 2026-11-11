---
title: Automations from the CLI
description: Create and manage Pimi automations and heartbeats with pimi automation and pimi heartbeat.
nav: CLI
order: 27
category: Automations
---

# Automations from the CLI

`pimi automation` creates and manages [automations](/docs/automations) from your terminal, useful for headless boxes and scripts. Every run starts a new agent.

## Create

`--name` and `--provider` are required. Pass `--cron` or `--every` for a schedule; without either, the automation runs only by hand.

Overnight refactor on Codex in a new worktree for each run:

```bash
pimi automation create \
  --every 30m \
  --name overnight-refactor \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  --worktree \
  --max-runs 16 \
  --expires-in 10h \
  "Continue the refactor. Run the focused checks. Leave a short status note."
```

Build check on Claude:

```bash
pimi automation create \
  --every 10m \
  --name build-watch \
  --provider claude/opus-4.7 \
  --cwd ~/dev/my-app \
  --max-runs 24 \
  "Check the release build. If it failed, inspect logs, fix the cause, and rerun."
```

Morning triage at 9 AM in New York, including daylight saving time changes:

```bash
pimi automation create \
  --cron "0 9 * * 1-5" \
  --timezone America/New_York \
  --name morning-triage \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  "Review overnight CI failures and summarize anything urgent."
```

A manual automation you start yourself:

```bash
pimi automation create \
  --name release-notes \
  --provider claude \
  --cwd ~/dev/my-app \
  "Draft release notes from the commits since the last tag."
```

Other options: `--mode <mode>` (default: the provider's unattended mode if it has one, otherwise its default mode), `--thinking <id>`. A run that stops at a permission prompt fails.

Run inside a Pimi agent, `create` makes a **pending** automation that waits for your approval. Approve it in the app or with `pimi automation approve <id>` from a normal terminal; agents cannot approve.

## Manage

```bash
pimi automation ls
pimi automation inspect <id>        # details and recent audit history
pimi automation runs <id> --limit 5 # runs, newest first
pimi automation run <id>            # start a run now
pimi automation pause <id>
pimi automation resume <id>
pimi automation approve <id>
pimi automation rm <id>
```

To change an automation, edit it in the app, or delete it and create a new one.

## Cadence

Use `--cron "<expr>"` for a 5-field cron expression. `--every <duration>` accepts intervals such as `15m` or `1h` and compiles them to cron; an interval cron cannot represent is rejected. It does not create a rolling interval anchored to creation time.

Cadences default to the host's time zone, and the stored cadence names it. Pass `--timezone <IANA>` to read them in a local wall-clock time zone, for example `--timezone America/New_York`, so the job stays at the same local time across daylight saving time changes.

Start the command with `pimi --host <target> automation create ...` when targeting a remote daemon. `--cwd` is required with `--host`; your local working directory may not exist on the remote machine.

## Heartbeats

A heartbeat sends a prompt back into the agent that created it. Inside a running Pimi agent:

```bash
pimi heartbeat create \
  --every 20m \
  --name continue \
  "Check the current task state and continue with the next useful step."
```

Give exactly one cadence:

| Flag                             | Fires                                       |
| -------------------------------- | ------------------------------------------- |
| `--cron "<expr>"` (`--timezone`) | On a cron cadence                           |
| `--every <duration>`             | At an interval, at least 30 seconds (`90s`) |
| `--in <duration>`                | Once, after a delay (`20m`)                 |
| `--at <ISO 8601>`                | Once, at that time                          |

A once-heartbeat fires one time and is removed; it waits while the agent is busy. `--name` is optional, and creating a heartbeat with an existing name replaces it. `--max-runs` and `--expires-in` set when it ends.

```bash
pimi heartbeat update <id> --every 10m  # change when it fires
pimi heartbeat delete <id>
pimi heartbeat ls
```

`create` must run inside a Pimi agent, which sets `PASEO_AGENT_ID`. Inside an agent, `update`, `delete`, and `ls` reach only that agent's heartbeats; outside one they reach every heartbeat on the host, so you can stop or reschedule any heartbeat by its id. `update` changes only the cadence. Heartbeats of an archived agent are deleted.
