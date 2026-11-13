---
title: Automations
description: Run a new agent with a prompt on a schedule or by hand, or wake an existing agent with a heartbeat.
nav: Overview
order: 25
category: Automations
---

# Automations

An automation starts a new agent with a prompt in a project. It runs on a schedule, or only when you run it by hand. Each run's results land in that run's agent chat.

Pimi also has **heartbeats**. A heartbeat sends a prompt back into one existing agent so it continues the same conversation. Heartbeats are managed by the agent itself, from [chat](/docs/automations-chat) or the [CLI](/docs/automations-cli#heartbeats), and do not appear in the Automations screen.

## What it's for

- **Recurring jobs:** start a clean agent for daily triage, reports, or maintenance.
- **Build babysitting:** check CI, EAS, Docker, or release builds on a cadence.
- **Maintenance sweeps:** refresh dependencies, audit docs, or clean stale branches.
- **Saved prompts:** keep a manual automation you run by hand when you need it.

## Create one in the app

Open **Automations** in the sidebar and choose **New automation**, or start from **Templates** (Weekday PR review, Weekly project digest). The form sets:

- **Name** (required) and **Prompt**
- **Trigger:** **On a schedule** with a **Cadence**, or **Run by hand**
- **Host** and **Project** to run in
- **Model**, **Thinking**, and **Mode** for the agent
- **Isolation:** **Local** runs in the project directory; **Worktree** creates a new worktree for each run
- **Max runs:** end the automation after this many runs

The app reads the cadence in your device's time zone. To change an automation later, edit it in the app; the CLI and agent tools cannot update one.

You can also create automations [from chat](/docs/automations-chat), [from the CLI](/docs/automations-cli), or [over MCP](/docs/mcp#automations-and-heartbeats).

## Approval

An automation an agent creates starts as **pending** and shows under **Needs your approval**. It does not run until you choose **Approve** in the app or run `pimi automation approve <id>` from a normal terminal. Agents cannot approve automations.

## Status

| Status                | Meaning                                                 |
| --------------------- | ------------------------------------------------------- |
| Pending               | Created by an agent and waiting for your approval.      |
| Active                | Runs on its schedule, or when you run it.               |
| Paused                | Paused by you or an agent; resume it to run again.      |
| Paused after failures | Three runs in a row failed. Fix the cause, then resume. |
| Ended                 | Reached its max runs or expired. It does not run again. |

## Limits

- Each run times out after 60 minutes.
- An automation runs at most 6 times per hour and at most 2 runs at once.
- The daemon runs at most 4 automation runs at once. Extra scheduled runs are skipped and recorded in the audit log.
- Slots missed while the daemon was down are skipped, not caught up.

## History

Pimi keeps each automation's last 50 runs, up to 30 days old, and an audit log of every change. `pimi automation runs <id>` lists runs; `pimi automation inspect <id>` shows the recent audit history.

Run chats stay after the run ends. Archive them like any other chat.
