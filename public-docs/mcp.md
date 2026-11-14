---
title: MCP reference
description: Reference for the Pimi tools agents use to manage agents, chats, scripts, terminals, automations, and heartbeats.
nav: MCP reference
order: 34
category: Orchestration
---

# MCP reference

Agents get this catalog unless you turn off [Enable Pimi tools](/docs/orchestration#get-started). Ask for an outcome in natural language, or use the tool interfaces below.

## Configuration

| Setting                       | Default | Purpose                                           |
| ----------------------------- | ------- | ------------------------------------------------- |
| `daemon.mcp.enabled`          | `true`  | Run the MCP server.                               |
| `daemon.mcp.injectIntoAgents` | `true`  | Give agents launched by Pimi access to its tools. |

Depending on the provider, Pimi delivers tools through its native tool interface or MCP. The capabilities are the same. Start a new agent or reload an existing one after changing injection settings.

## Limit Pimi tools by provider

Use provider policies when different agent profiles should receive different Pimi tools. Enable
tool injection globally, then add `pimiTools` to the exact provider IDs you launch:

```json
{
  "$schema": "https://raw.githubusercontent.com/1ikeadragon/pimi/main/packages/server/schemas/pimi.config.v1.json",
  "version": 1,
  "daemon": {
    "mcp": {
      "enabled": true,
      "injectIntoAgents": true
    }
  },
  "agents": {
    "providers": {
      "codex-lead": {
        "extends": "codex",
        "label": "Codex Lead"
      },
      "codex-worker": {
        "extends": "codex",
        "label": "Codex Worker",
        "pimiTools": {
          "disabledTools": ["create_agent", "send_agent_prompt", "kill_agent"]
        }
      },
      "codex-isolated": {
        "extends": "codex",
        "label": "Codex Isolated",
        "pimiTools": {
          "enabled": false
        }
      }
    }
  }
}
```

Run `pimi reload` after editing `~/.pimi/config.json`, then start a new agent or reload an
existing one. A running session keeps the catalog it received at launch.

Omitting `pimiTools` enables the complete catalog. Set `enabled` to `false` to remove the catalog,
or list exact tool IDs in `disabledTools` to remove selected tools. Custom profiles do not inherit
this policy from `extends`; configure each custom provider ID separately.

Browser tools still require browser tools to be enabled and a connected browser host. The
voice-only `speak` tool is separate from this policy.

This setting limits the catalog presented to an agent. It is not a security boundary for an agent
that can access the host through a shell.

## Mental model

Chats decide where work happens; agent parentage decides who owns the work.

- An agent that calls `create_agent` without a `chatId` gets a subagent in its own chat. `create_agent` always creates the caller's subagent.
- Passing a `chatId` places that subagent in another chat without detaching it from its parent.
- To open a new chat for the user, call `create_chat` with `initialPrompt`. The agent that starts there has no parent: it shows no card in the caller's chat, is not archived with the caller, and sends no finish notification.
- A top-level MCP caller without a chat gets a new local chat.
- Create a chat first when you need worktree isolation, a specific branch, or a pull request checkout.

MCP does not expose an agent-detach tool. Detaching is a manual user action in the app or CLI.

## Tools

### Agents

| Tool                 | Function                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_agent`       | Create a subagent, optionally placing it in an existing chat with `chatId`. Use `initialPrompt` to start work; returns without waiting for completion. `background: true` hides it from tabs, default lists, your subagent track and notifications; you still get its finish notification. Omission inherits your own value. |
| `send_agent_prompt`  | Send a prompt using `agentId` and `prompt`; returns without waiting for completion.                                                                                                                                                                                                                                          |
| `get_agent_status`   | Return the latest snapshot for an agent.                                                                                                                                                                                                                                                                                     |
| `list_agents`        | List recent agents as compact metadata; `includeBackground: true` includes background work.                                                                                                                                                                                                                                  |
| `cancel_agent`       | Abort an agent's current run but keep the agent alive.                                                                                                                                                                                                                                                                       |
| `archive_agent`      | Soft-delete an agent and remove it from the active list.                                                                                                                                                                                                                                                                     |
| `kill_agent`         | Terminate an agent session permanently.                                                                                                                                                                                                                                                                                      |
| `update_agent`       | Update an agent name, labels, or runtime settings such as mode/model/thinking/features.                                                                                                                                                                                                                                      |
| `get_agent_activity` | Return recent agent timeline entries as a curated summary.                                                                                                                                                                                                                                                                   |
| `set_agent_mode`     | Switch an agent's session mode.                                                                                                                                                                                                                                                                                              |

Pimi agents receive finish, error, and permission notifications by default; set `notifyOnFinish: false` to disable them. External MCP clients use `get_agent_status` and `get_agent_activity` to check results.

### Chats and projects

| Tool            | Function                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_chat`   | Open a new top-level chat, in the caller's project or the one named by `project` (id or name). Local or worktree-isolated; worktrees can branch off, check out a branch, or a PR. With `initialPrompt` (and `title`) an agent starts there on its own. `background: true` hides the chat from default lists and the sidebar while preserving history and access by ID; it is not accepted with `initialPrompt`. |
| `list_chats`    | List active chats and their directories and isolation. Use `includeBackground: true` to include background chats.                                                                                                                                                                                                                                                                                               |
| `list_projects` | List the user's projects with `projectId`, `name`, and `path`.                                                                                                                                                                                                                                                                                                                                                  |
| `rename_chat`   | Change the user-visible name of the current or specified chat.                                                                                                                                                                                                                                                                                                                                                  |
| `archive_chat`  | Archive a chat and the sessions it owns.                                                                                                                                                                                                                                                                                                                                                                        |

For worktree isolation, `create_chat` accepts the same useful choices as the app: branch off from a base, check out an existing branch, or check out a pull request. On another host `create_chat` opens an empty chat; follow with `create_agent` and that `chatId`.

### Scripts

These tools manage scripts configured in a chat's `pimi.json`. Each requires an explicit `chatId`; start and stop also require the configured `scriptName`.

| Tool           | Function                                                                                |
| -------------- | --------------------------------------------------------------------------------------- |
| `list_scripts` | List configured scripts with lifecycle, terminal, port, proxy URL, and health metadata. |
| `start_script` | Start a configured script through Pimi's managed launcher.                              |
| `stop_script`  | Stop a running script through its supervised terminal.                                  |

See [Git worktrees](/docs/worktrees#scripts-and-services) for `pimi.json` configuration.

### Terminals

| Tool                 | Function                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| `list_terminals`     | List terminal sessions for one working directory or all working directories. |
| `create_terminal`    | Create a terminal session for a working directory.                           |
| `kill_terminal`      | Kill a terminal session.                                                     |
| `capture_terminal`   | Capture plain-text output from a terminal session.                           |
| `send_terminal_keys` | Send text or special key tokens to a terminal session.                       |

### Automations and heartbeats

An [automation](/docs/automations) starts a new agent for each run. A heartbeat sends a prompt back into the calling agent.

| Tool                  | Function                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create_automation`   | Create an automation with a name and prompt, on a cron cadence or run by hand when `cron` is omitted. It uses the caller's provider, model, mode, and thinking unless `provider` is given. |
| `list_automations`    | List all automations on this host.                                                                                                                                                         |
| `inspect_automation`  | Inspect an automation and its audit history.                                                                                                                                               |
| `pause_automation`    | Pause an active automation.                                                                                                                                                                |
| `delete_automation`   | Delete an automation you created that is still waiting for approval.                                                                                                                       |
| `automation_runs`     | List an automation's recent runs, newest first.                                                                                                                                            |
| `run_automation_once` | Start a run of an active automation now.                                                                                                                                                   |
| `create_heartbeat`    | Send yourself a prompt later: give exactly one of `cron`, `every` (at least 30s), `in` (once, after a duration), or `at` (once, at an ISO time).                                           |
| `delete_heartbeat`    | Delete one of your heartbeats.                                                                                                                                                             |
| `list_heartbeats`     | List your heartbeats with when each fires next.                                                                                                                                            |

`create_automation` always creates a pending automation. It does not run until the user [approves it](/docs/automations#approval). Agents cannot approve, resume, or update automations. To change a heartbeat, delete it and create a replacement.

### Agent profiles

| Tool            | Function                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_profiles` | Return the host's agent profiles, including their notes, instructions, and launch settings. Returns an empty list when none are configured. |

Before delegating, read each profile's `notes` and choose the profile the user named or the one that fits the task. See [Agent profiles](/docs/agent-profiles) for setup and example notes.

Pass the chosen profile's id or name as `profile` to `create_agent`. The agent starts with the profile's instructions as its system prompt, and the profile's provider, model, mode, thinking level, and features fill anything the call leaves out; values in the call win. A profile without a provider needs `provider` in the call. `create_automation` also takes `profile`: each run's agent starts with that profile's instructions.

If no profile fits, use provider discovery to choose available settings.

### Providers

| Tool               | Function                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `list_providers`   | List configured agent providers, availability, and modes.         |
| `list_models`      | List models for an agent provider.                                |
| `inspect_provider` | Inspect compact provider capabilities and draft feature settings. |

### Permissions

| Tool                       | Function                                          |
| -------------------------- | ------------------------------------------------- |
| `list_pending_permissions` | Return pending permission requests across agents. |
| `respond_to_permission`    | Approve or deny a pending permission request.     |

### Browser

Browser automation is opt-in and adds tools for opening tabs, reading pages, clicking, typing, and taking screenshots. See the [Browser tools reference](/docs/browser-tools).

### Voice

| Tool    | Function                                                                                  |
| ------- | ----------------------------------------------------------------------------------------- |
| `speak` | Speak text through daemon-managed voice output. Available only in voice-enabled sessions. |
