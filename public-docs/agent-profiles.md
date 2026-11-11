---
title: Agent profiles
description: Give agents instructions and settings for a kind of work, and use notes to guide delegation for reviews, investigations, and implementation.
nav: Agent profiles
order: 32
category: Orchestration
---

# Agent profiles

A profile is a ready setup for a kind of work: **instructions** the agent starts with, and optionally a provider, model, mode, thinking level, and features.

- **For you:** pick a profile when starting an agent, and it starts with the profile's instructions and settings.
- **For an orchestrating agent:** profile notes explain when to use each profile for delegated work.
- **For automations:** each run's agent can start with a profile.

Pimi ships four built-in profiles: **Adversarial reviewer**, **Report writer**, **Investigator**, and **Implementer**. You can edit them, reset an edited one to its default, or delete them; a deleted built-in does not come back.

## Create a profile

1. Open **Profiles** in the sidebar (on the web, **Settings → your host → Agents → Open profiles**).
2. Select **New profile** and give it a name, such as **UI work**.
3. Write its **Instructions**: what the agent should know and how it should work.
4. Choose a provider, model, mode, and thinking level, or leave the provider on **Any provider** to keep whatever the agent is started with.
5. Fill in **When to use** with the kind of work this profile should handle.
6. Select **Save**.

Profiles are saved on that host. **Try it** on a profile's page opens a new chat with the profile attached.

## Start an agent with a profile

When creating an agent, open the model picker and select a profile under **Profiles**. The draft shows a profile chip; when you send, the agent starts with the profile's instructions as its system prompt and its saved settings. Remove the chip to send without the instructions. The chat keeps showing which profile the agent started with.

Picking a profile on an agent that is already running changes its model, mode, and thinking level only: instructions can be given to an agent only when it starts, so Pimi offers to start a new agent with the profile.

Editing a profile affects agents started afterwards. It does not change agents you already started.

From the CLI, `pimi run --profile "<name>" "<task>"` and `pimi automation create --profile "<name>" ...` do the same.

## Guide delegation with notes

The **When to use** field is the profile's notes. Pimi exposes these notes through its tools so an orchestrating agent can read them before choosing how to launch a worker.

Give each profile a clear specialty:

| Profile  | Example notes                                                                                |
| -------- | -------------------------------------------------------------------------------------------- |
| UI work  | Use for components, layout, styling, and visual polish.                                      |
| Planning | Use for architecture, investigating root causes, and comparing implementation approaches.    |
| Review   | Use for independent review of diffs, correctness, missing tests, and unnecessary complexity. |

Each profile can use a different provider and model, or different settings for the same model.

After [enabling Pimi tools](/docs/orchestration#get-started), ask:

> Check my Pimi profiles and their notes. Choose one for the settings-page UI change, then use a review profile for an independent review of the diff.

The orchestrator reads the profiles, selects settings for each task, and launches the workers. Notes guide that choice; put the worker's actual assignment in its task prompt.

The bundled [Pimi skill](/docs/skills#paseo-paseo-reference) instructs agents to check profiles and read their notes before delegating. If none fit, it directs the agent to discover configured providers and models and tell you about the fallback.

See [Common workflows](/docs/orchestration-workflows) for delegation examples or the [MCP reference](/docs/mcp#agent-profiles) for the tool interface.
