---
name: pimi
description: Pimi tool and CLI reference for hosts, projects, workspaces, scripts, terminals, agents and subagents, profiles and providers, permissions, schedules, heartbeats, browser tabs, Spaces, and code search.
---

Pimi manages coding agents and terminals through a daemon. Use the Pimi MCP tools in an agent session, or the bundled `pimi` CLI from a shell.

## Connected hosts

Call `list_hosts` to discover the calling daemon (`self`) and its registered destinations (`hosts`). Use a destination's `serverId` for tool calls; labels are display names.

`create_workspace`, `list_workspaces`, `create_agent`, `send_agent_prompt`, `get_agent_status`, `get_agent_activity`, and `list_agents` accept `serverId`. Omit it for the calling daemon. Other MCP tools operate on the calling daemon.

Keep an agent's `{ serverId, agentId }` together. For example, call `send_agent_prompt` with:

```json
{ "serverId": "srv_build", "agentId": "agent_123", "prompt": "Continue", "notifyOnFinish": true }
```

Remote paths and workspace IDs belong to the destination. Remote `list_agents` has no caller-directory default; pass `cwd` to filter it.

Manage registrations through the CLI; use the returned `registrationId` for updates and removal:

```bash
pimi --host localhost:6768 host add localhost:6779 --label build
pimi --host localhost:6768 host ls --json
```

## Spaces

Call `search_pimi_spaces` with a few keywords when asked to find a note or link in Spaces. Use `read_pimi_space_item` with a matching `space:` reference or one the user gives you.

## Projects

Manage the daemon's project registry through the CLI:

```bash
pimi project create [path]
pimi project ls
pimi project rename <project-id> <name>
pimi project rename <project-id> --reset
pimi project delete <project-id>
```

For a local daemon, `project create` defaults to the current directory and resolves relative paths on the CLI machine. With `--host`, always provide a path; the target daemon interprets it on its own machine. Deleting a project archives its active workspaces and removes the project from Pimi without deleting the project directory.

## Workspaces

**`create_workspace`** — create a workspace independently of any agent. Required: `isolation` (`local` or `worktree`). Worktree isolation supports `mode: "branch-off" | "checkout-branch" | "checkout-pr"`: use `branchName`/`baseBranch` for a new branch, `branch` for an existing branch, or `prNumber` plus optional `forge` for a change request. Use `path` for a local directory or source checkout and `projectId` for the owning project; when no path is supplied, a worktree may resolve its source from `projectId`. `worktreeSlug` controls the managed path. Returns the workspace descriptor centered on `workspaceId`.

`background: true` hides a workspace from default lists and the sidebar while its contents remain durable and accessible; omit `background` to inherit your current workspace’s value (false without a caller), and override it only when the user explicitly asks.

Choose `baseBranch` explicitly: `origin/main` selects the remote-tracking branch; `refs/heads/main` selects local main. Bare `main` prefers local main when it exists, otherwise origin/main. Pimi retains the resolved ref for workspace comparisons, even after rebasing the branch or changing its PR target.

**`list_workspaces`** — list active workspaces, excluding background workspaces unless `includeBackground: true`.

**`archive_workspace`** — `{ workspaceId }`. Archives the workspace, its agents, and its terminals. Local directories remain; Pimi removes an owned worktree only after its final active workspace reference is archived.

**`rename_workspace`** — `{ workspaceId?, title }`. Sets the workspace's visible title. Omit `workspaceId` to rename your own workspace.

## Find code

Use `search_pimi_codebase` when you know what the code should do but can't name the file or identifier. Open the returned file and check the surrounding lines before citing it.

## Workspace scripts

Configured `pimi.json` scripts use the same supervised lifecycle from tools and the CLI.

**`list_workspace_scripts`** — `{ workspaceId }`. Lists configured scripts with lifecycle, service port, proxy URLs, health, exit code, and terminal ID.

**`start_workspace_script`** — `{ workspaceId, scriptName }`. Starts one configured script through Pimi's managed workspace-script launcher and returns its status metadata.

**`stop_workspace_script`** — `{ workspaceId, scriptName }`. Stops a running script through its supervised terminal and returns the stopped status metadata.

The matching CLI surface accepts either an explicit workspace ID or resolves the current directory:

```bash
pimi script ls [--cwd <path> | --workspace <workspace-id>]
pimi script start <name> [--cwd <path> | --workspace <workspace-id>]
pimi script stop <name> [--cwd <path> | --workspace <workspace-id>]
```

## Agents

**`create_agent`** — required: `title`, `provider` (`claude/opus`, `codex/gpt-5.4`, …), `initialPrompt`. Optional: `workspaceId`, `notifyOnFinish`, `inheritContext`, `background`, `settings`, `labels`. Returns `{ agentId, workspaceId, … }`.

`inheritContext: true` attaches this chat to the new agent as reference history. It works only for a subagent on your own host, and long history is shortened.

- Set it when the agent continues or contributes to work discussed in this chat: a handoff, or another provider's take.
- Omit it when the agent must judge the problem without your reasoning in front of it, as in **pimi-committee**, and for an agent on another host.
- Write a complete `initialPrompt` in both cases. It defines the assignment; the attached history does not.

`background: true` hides the agent from tabs, default lists, and your subagents track. You still get its finish notification and can address it by ID. Omit it to inherit your own value. Use it for a helper the user does not need to watch.

Initial runtime settings live under `settings`: `modeId`, `thinkingOptionId`, and provider-specific `features`. Agent profiles are the preferred source for these values. For Codex speed, pass `settings: { features: { "service_tier": "<tier id>" } }` when creating the agent, using a tier id from `inspect_provider`.

Agent-scoped creation always creates your subagent. On your own host, omit `workspaceId` to use your current workspace. On another host, first list or create a workspace with that `serverId`, then pass its `workspaceId` and the same `serverId` to `create_agent`. Placement never changes parentage.

Detach is an explicit user action in the subagents track, not an agent tool. A cross-workspace child remains your subagent even though it also appears as a normal tab in its workspace.

Agent-scoped `create_agent` defaults `notifyOnFinish` to true. Set it to `false` when you want explicit reporting or no completion callback.

**`send_agent_prompt`** — `{ agentId, prompt, activeTurnBehavior? }`. Use for follow-ups to an existing agent. Agent-scoped calls default to `steer`; top-level calls default to `interrupt`. Set `activeTurnBehavior` to `steer` or `interrupt` to override the default. Steering falls back to interruption when unavailable. CLI agent sends use the same defaults and accept `--behavior steer|interrupt`. Agent-scoped calls return a queued receipt immediately; messages to each recipient deliver after two quiet seconds. Top-level calls return after dispatch acknowledgement. Agent-scoped calls default `notifyOnFinish` to true; top-level calls have no parent callback.

**`update_agent`** — `{ agentId, name?, labels?, settings? }`. Use `settings` for runtime changes on an existing agent: `modeId`, `model`, `thinkingOptionId`, and provider-specific `features`. For Codex speed, pass `settings: { features: { "service_tier": "<tier id>" } }`.

**`list_agents`** — use `workspaceId` for one exact workspace, or filter by `cwd`, `statuses`, `sinceHours`, or `includeArchived`. Set `includeBackground: true` to include agents in background workspaces.

**`get_agent_activity`** — `{ agentId, limit? }`. Reads an agent's recent timeline as a summary. Use it when the finish notification does not carry enough of the result.

**`cancel_agent`** — `{ agentId }`. Stops the current run and keeps the agent for follow-up prompts.

**`archive_agent`** — `{ agentId }`. Interrupts if running, removes from active list. Use it when the work is done.

**`kill_agent`** — `{ agentId }`. Ends the agent's session permanently. Prefer `cancel_agent` to stop a run and `archive_agent` to finish.

**`set_agent_mode`** — `{ agentId, modeId }`. Switches the mode of an existing agent. Take `modeId` from the `availableModes` that `create_agent` returned or from `list_providers`.

## Permissions

A subagent that needs permission stops until someone answers. Its notification tells you when that happens.

**`list_pending_permissions`** — no input. Returns `{ agentId, request }` for every pending request on this daemon.

**`respond_to_permission`** — `{ agentId, requestId, response }`. Use the request's `id` as `requestId`. `response` is `{ behavior: "allow" }` or `{ behavior: "deny", message?, interrupt? }`.

Allow only what the user's instructions for this work cover. Otherwise tell the user what the agent is asking for.

## Agent profiles and provider discovery

**`list_profiles`** — named launch bundles configured by the human. Before choosing how to launch a delegated agent, call this tool and read every profile's `notes`. Pick a named profile the user requested, or the profile whose notes best match the work.

There is no `profile` parameter on `create_agent`. Materialize the selected profile into the call:

- combine `provider` and `model` as the `provider/model` value for `create_agent.provider`
- copy `modeId` to `settings.modeId`
- copy `thinkingOptionId` to `settings.thinkingOptionId`
- copy `featureValues` to `settings.features`

Omit absent values. Do not remember a selected profile or infer drift later; a profile is only launch configuration.

If no profile fits, or no profiles are configured, use the provider discovery tools below. Tell the user when you fall back because no configured profile fits.

**`list_providers`** — compact provider availability and modes. A custom provider from the host's `config.json` is listed under its own ID; pass that ID as the provider part of `provider/model`. An agent profile from `list_profiles` is a launch bundle, not a provider ID.

**`list_models`** — full model list for one provider. Use only when you need model IDs or thinking options; the list can be large.

**`inspect_provider`** — compact provider capability and feature inspection. Required: `provider`; pass `cwd` when you are not in an agent-scoped session. Optional: `settings` with draft `model`, `modeId`, `thinkingOptionId`, and `features`.

Only set feature IDs returned by `inspect_provider`. For Codex speed, look for `service_tier` and pass `settings: { features: { "service_tier": "<tier id>" } }` to `create_agent` or `update_agent`.

## Terminals

Use a terminal for a long-running or interactive process the user should be able to see, such as a dev server or a REPL. Use a workspace script when `pimi.json` already defines the process.

**`create_terminal`** — `{ cwd?, name? }`. Opens a terminal in your working directory or `cwd`. Returns its `id`.

**`send_terminal_keys`** — `{ terminalId, keys, literal? }`. Sends text or one key token such as `Enter`, `Tab`, `Escape`, `Up`, or `C-c`. A command does not run until you send `Enter` in a second call. Set `literal: true` to send text that looks like a key token unchanged.

**`capture_terminal`** — `{ terminalId, start?, end?, scrollback? }`. Returns output lines as plain text. Set `scrollback: true` to read from the beginning.

**`list_terminals`** — `{ cwd?, all? }`. Lists terminals for one directory, or every directory with `all: true`.

**`kill_terminal`** — `{ terminalId }`. Kill the terminals you created when you are done with them.

## Browser

The `browser_*` tools drive tabs in the Pimi desktop app's browser. They exist only when the host has browser tools enabled, and they need a workspace and a connected desktop app.

1. `browser_new_tab` with a URL, or `browser_list_tabs`, gives you a `browserId`. Pass it to every other browser tool.
2. `browser_snapshot` returns the page with element `ref`s.
3. Act on a `ref` with `browser_click`, `browser_fill`, `browser_type`, `browser_keypress`, `browser_select`, `browser_hover`, `browser_drag`, or `browser_upload`.
4. Take a new `browser_snapshot` after the page changes. Old `ref`s expire.

Use `browser_wait` for text or a URL to appear, `browser_screenshot` for visual checks, `browser_logs` for console and network entries, and `browser_evaluate` to run JavaScript in the page. Close tabs you opened with `browser_close_tab`.

## Automations and heartbeats

**`create_schedule`** — starts a new agent on a cron cadence. Required: `prompt`, `cron`. Optional: `provider`, `timezone`, `name`, `cwd`, `isolation` (`local` or `worktree`), `maxRuns`, `expiresIn`. Use when the recurring work should live in fresh agents.

Without `provider`, runs use your provider, model, and mode; without `cwd`, your working directory. Set `isolation` to `worktree` when each run should edit in its own worktree and not in that directory.

**`create_heartbeat`** — sends you a prompt on a cron cadence. Required: `prompt`, `cron`. Optional: `timezone`, `name`, `maxRuns`, `expiresIn`. Use for reminders, PR/build babysitting, and status checks that should return to this conversation.

**`delete_heartbeat`** — `{ id }`. Stops one of your heartbeats. No tool lists or updates heartbeats: keep the `id` that `create_heartbeat` returns, and delete and recreate to change the task or cadence.

Manage a schedule by `id` with `list_schedules`, `inspect_schedule`, `update_schedule`, `pause_schedule`, `resume_schedule`, `run_schedule_once`, `schedule_logs`, and `delete_schedule`. `update_schedule` changes only the fields you pass. Call `run_schedule_once` to test a new schedule without waiting for its cadence.

## Waiting

When you create or prompt a subagent, `notifyOnFinish` defaults to `true` and reports completion, errors, or permission requests, including across hosts.
Finish your turn and wait for that notification instead of polling.
To get the answer as a message instead, set `notifyOnFinish: false` and tell the agent to reply with `send_agent_prompt` to your `agentId`. For an agent on another host, also give it your `serverId` (`self` in `list_hosts`). It can reach you only when its own `list_hosts` shows your daemon; keep the default notification when it does not.

## CLI semantics

The CLI and tools use the same ownership semantics even where their syntax differs:

```bash
pimi workspace create --isolation worktree --mode branch-off --new-branch fix-x --base origin/main
pimi workspace create --isolation worktree --mode checkout-branch --branch existing-work
pimi workspace create --isolation worktree --mode checkout-pr --pr-number 42
pimi run --provider codex/gpt-5.4 --mode full-access --workspace <workspace-id> "<prompt>"
pimi run --provider codex/gpt-5.4 --mode full-access --new-workspace worktree --worktree-mode branch-off --new-branch fix-x --base origin/main "<prompt>"
pimi send <agent-id> "<follow-up>"
pimi ls
pimi schedule create --cron "*/15 * * * *" "ping main build"
pimi heartbeat create --cron "*/15 * * * *" "check the build"
pimi agent mode <agent-id> --list
pimi agent mode <agent-id> <mode>
pimi agent update <agent-id> --name <name> --label key=value
pimi permit ls
pimi permit allow <agent-id> <request-id>
pimi permit deny <agent-id> <request-id> --message "<reason>"
pimi terminal ls --all
pimi terminal capture <terminal-id> --scrollback
pimi terminal send-keys <terminal-id> "npm test" Enter
pimi usage ls
pimi usage inspect <report-id>
pimi daemon config get [path]
pimi daemon config set <path> <value>
```

`pimi usage` reports provider account quotas and balances, not an agent's token consumption. `pimi daemon config` edits the local daemon's `config.json` and reloads it; it does not take `--host`.

Discover with `pimi --help` and `pimi <cmd> --help`.

For product questions, setup, logs, version problems, or troubleshooting, use the **pimi-help** skill.
