---
title: Automations from chat
description: Ask an agent in chat to set up an automation or a heartbeat for you.
nav: Chat
order: 26
category: Automations
---

# Automations from chat

In any agent chat, ask, and the agent sets up the automation for you through [Pimi MCP](/docs/mcp#automations-and-heartbeats).

Example prompts:

- "Every weekday at 9am, triage new GitHub issues and PRs and summarize what needs attention."
- "Check the release build every 10 minutes, and fix the cause if it fails."
- "Keep working on this refactor. Wake yourself every 20 minutes and continue where you left off."

The agent picks the cadence and prompt from what you asked. The new agent uses the same provider, model, mode, and thinking as the agent you asked, unless you name a provider. Without a cadence, the automation runs only by hand.

An automation an agent creates stays **pending** until you approve it in the [Automations screen](/docs/automations#approval) or with `pimi automation approve <id>`. The agent cannot approve it.

After approval, the agent can list, inspect, pause, and start runs of automations, and delete its own automations while they are still pending. To resume, edit, or delete an approved automation, use the app or the [CLI](/docs/automations-cli).

## Heartbeats

An agent waking itself later is a **heartbeat**. The prompt goes back into the same agent and conversation, on a cron cadence, at an interval, or once after a delay or at a time. A recurring heartbeat that fires while the agent is busy fails for that slot; a once-heartbeat waits until the agent is free. Heartbeats need no approval; the agent can create, list, and delete its own. To change one, ask the agent to delete it and create a replacement.
