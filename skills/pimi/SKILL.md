---
name: pimi
description: Pimi tool and CLI reference for hosts, projects, chats, scripts, terminals, agents and subagents, profiles and providers, permissions, automations, heartbeats, browser tabs, Spaces, and code search.
---

Pimi manages coding agents and terminals through a daemon. Use the Pimi MCP tools in an agent session, or the bundled `pimi` CLI from a shell.

## Connected hosts

`list_hosts` returns the calling daemon (`self`) and its registered destinations (`hosts`). Labels are display names; tool calls take the `serverId`.

Keep an agent's `{ serverId, agentId }` together. For example, call `send_agent_prompt` with:

```json
{ "serverId": "srv_build", "agentId": "agent_123", "prompt": "Continue", "notifyOnFinish": true }
```

Remote paths and chat IDs belong to the destination. Remote `list_agents` has no caller-directory default; pass `cwd` to filter it. Other MCP tools operate on the calling daemon.

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

For a local daemon, `project create` defaults to the current directory and resolves relative paths on the CLI machine. With `--host`, always provide a path; the target daemon interprets it on its own machine. Deleting a project archives its active chats and removes the project from Pimi without deleting the project directory.

## Chats

A chat is one unit of work in a project: a sidebar row with its own working directory, terminals, and agents. Projects have a `projectId`, chats a `chatId`, agents an `agentId`.

**`list_projects`** — the user's projects, each with `projectId`, `name`, and `path`. Pass a project's id or name as `project` to `create_chat`.

**`create_chat`** — open a new top-level chat. This is the only way to start an independent chat: when the user asks to open or start a new chat, call it with `initialPrompt`, and the agent that starts there is the user's own, not your subagent. Without `initialPrompt` the chat is empty; pass its `chatId` to `create_agent` to put a worker on it. `isolation` is `local` (default) or `worktree`. Worktree isolation supports `mode: "branch-off" | "checkout-branch" | "checkout-pr"`: use `branchName`/`baseBranch` for a new branch, `branch` for an existing branch, or `prNumber` plus optional `forge` for a change request. Use `project` (id or name) for the owning project and `path` for a specific directory or source checkout; when neither is supplied the chat opens in your own project. `worktreeSlug` controls the managed path. Returns the chat descriptor centered on `chatId`, plus `agentId` when an agent started.

With `initialPrompt`, also pass `title` (the agent's title) and optionally `provider`, `profile`, `settings`, and `inheritContext`. The agent has no parent: it shows no card in your chat, is not archived with you, and sends you no finish notification. On another host `create_chat` opens an empty chat only; follow with `create_agent` and that `chatId` and `serverId`. Inside an Attack run, use `create_agent` instead.

`background: true` hides a chat from default lists and the sidebar while its contents remain durable and accessible; omit `background` to inherit your current chat’s value (false without a caller), and override it only when the user explicitly asks. It is not accepted with `initialPrompt`.

Choose `baseBranch` explicitly: `origin/main` selects the remote-tracking branch; `refs/heads/main` selects local main. Bare `main` prefers local main when it exists, otherwise origin/main. Pimi retains the resolved ref for chat comparisons, even after rebasing the branch or changing its PR target.

**`list_chats`** — list active chats, excluding background chats unless `includeBackground: true`.

**`archive_chat`** — `{ chatId }`. Archives the chat, its agents, and its terminals. Local directories remain; Pimi removes an owned worktree only after its final active chat reference is archived.

**`rename_chat`** — `{ chatId?, title }`. Sets the chat's visible title. Omit `chatId` to rename your own chat.

## Find code

Use `search_pimi_codebase` when you know what the code should do but can't name the file or identifier. Open the returned file and check the surrounding lines before citing it.

## Scripts

Configured `pimi.json` scripts use the same supervised lifecycle from tools and the CLI.

**`list_scripts`** — `{ chatId }`. Lists configured scripts with lifecycle, service port, proxy URLs, health, exit code, and terminal ID.

**`start_script`** — `{ chatId, scriptName }`. Starts one configured script through Pimi's managed script launcher and returns its status metadata.

**`stop_script`** — `{ chatId, scriptName }`. Stops a running script through its supervised terminal and returns the stopped status metadata.

The matching CLI surface accepts either an explicit chat ID or resolves the current directory:

```bash
pimi script ls [--cwd <path> | --chat <chat-id>]
pimi script start <name> [--cwd <path> | --chat <chat-id>]
pimi script stop <name> [--cwd <path> | --chat <chat-id>]
```

## Agents

**`create_agent`** — required: `title`, `initialPrompt`, and `provider` (`claude/opus`, `codex/gpt-5.4`, …) unless you pass a `profile` that sets one. Optional: `profile`, `chatId`, `notifyOnFinish`, `inheritContext`, `background`, `settings`, `labels`. Returns `{ agentId, chatId, … }`.

`inheritContext: true` attaches this chat to the new agent as reference history. It works only for a subagent on your own host, and long history is shortened.

- Set it when the agent continues or contributes to work discussed in this chat: a handoff, or another provider's take.
- Omit it when the agent must judge the problem without your reasoning in front of it, as in **pimi-committee**, and for an agent on another host.
- Write a complete `initialPrompt` in both cases. It defines the assignment; the attached history does not.

`background: true` hides the agent from tabs, default lists, and your subagents track. You still get its finish notification and can address it by ID. Omit it to inherit your own value. Use it for a helper the user does not need to watch.

Initial runtime settings live under `settings`: `modeId`, `thinkingOptionId`, and provider-specific `features`. Agent profiles are the preferred source for these values. For Codex speed, pass `settings: { features: { "service_tier": "<tier id>" } }` when creating the agent, using a tier id from `inspect_provider`.

`create_agent` always creates your subagent; to open a chat for the user, use `create_chat` with `initialPrompt`. On your own host, omit `chatId` to use your current chat. On another host, first list or create a chat with that `serverId`, then pass its `chatId` and the same `serverId` to `create_agent`. Placement never changes parentage.

Detach is an explicit user action in the subagents track, not an agent tool. A child in another chat remains your subagent even though it also appears as a normal tab in that chat.

Agent-scoped `create_agent` defaults `notifyOnFinish` to true. Set it to `false` when you want explicit reporting or no completion callback.

**`send_agent_prompt`** — `{ agentId, prompt, activeTurnBehavior? }`. Use for follow-ups to an existing agent. Agent-scoped calls default to `steer`; top-level calls default to `interrupt`. Set `activeTurnBehavior` to `steer` or `interrupt` to override the default. Steering falls back to interruption when unavailable. CLI agent sends use the same defaults and accept `--behavior steer|interrupt`. Agent-scoped calls return a queued receipt immediately; messages to each recipient deliver after two quiet seconds. Top-level calls return after dispatch acknowledgement. Agent-scoped calls default `notifyOnFinish` to true; top-level calls have no parent callback.

**`update_agent`** — `{ agentId, name?, labels?, settings? }`. Use `settings` for runtime changes on an existing agent: `modeId`, `model`, `thinkingOptionId`, and provider-specific `features`. For Codex speed, pass `settings: { features: { "service_tier": "<tier id>" } }`.

**`list_agents`** — use `chatId` for one exact chat, or filter by `cwd`, `statuses`, `sinceHours`, or `includeArchived`. Set `includeBackground: true` to include agents in background chats.

**`get_agent_activity`** — `{ agentId, limit? }`. Reads an agent's recent timeline as a summary. Use it when the finish notification does not carry enough of the result.

**`cancel_agent`** — `{ agentId }`. Stops the current run and the runs of its working subagents, keeping them for follow-up prompts. When the user asks you to pause your subagents, cancel each one; to resume, send it a `send_agent_prompt`.

**`archive_agent`** — `{ agentId }`. Interrupts if running, removes from active list. Use it when the work is done.

**`kill_agent`** — `{ agentId }`. Ends the agent's session permanently. Prefer `cancel_agent` to stop a run and `archive_agent` to finish.

**`set_agent_mode`** — `{ agentId, modeId }`. Switches the mode of an existing agent. Take `modeId` from the `availableModes` that `create_agent` returned or from `list_providers`.

## Permissions

A subagent that needs permission stops until someone answers. Its notification tells you when that happens.

**`list_pending_permissions`** — no input. Returns `{ agentId, request }` for every pending request on this daemon.

**`respond_to_permission`** — `{ agentId, requestId, response }`. Use the request's `id` as `requestId`. `response` is `{ behavior: "allow" }` or `{ behavior: "deny", message?, interrupt? }`.

Allow only what the user's instructions for this work cover. Otherwise tell the user what the agent is asking for.

## Agent profiles and provider discovery

**`list_profiles`** — agent profiles the user keeps for kinds of work, such as reviewing or investigating. Call it before you delegate and read each profile's `notes`. Use the profile the user named, or the one whose notes match the work.

Pass the profile's id or name as `profile` to `create_agent`. The agent starts with the profile's `instructions` as its system prompt, so `initialPrompt` carries only the assignment; do not repeat the role there.

- Omit `provider` to run on the profile's provider and model. A profile without `provider` runs on yours.
- Pass `provider` to run the same instructions elsewhere, for example one reviewer profile on `claude` and again on `codex`. The profile's mode, thinking, and features then apply only if that is the profile's own provider.
- `settings` you pass win over the profile's.

If no profile fits, or no profiles are configured, use the provider discovery tools below. Tell the user when you fall back because no configured profile fits.

**`list_providers`** — compact provider availability and modes. A custom provider from the host's `config.json` is listed under its own ID; pass that ID as the provider part of `provider/model`. An agent profile from `list_profiles` is a launch bundle, not a provider ID.

**`list_models`** — full model list for one provider. Use only when you need model IDs or thinking options; the list can be large.

**`inspect_provider`** — compact provider capability and feature inspection. Required: `provider`; pass `cwd` when you are not in an agent-scoped session. Optional: `settings` with draft `model`, `modeId`, `thinkingOptionId`, and `features`.

Only set feature IDs returned by `inspect_provider`. For Codex speed, look for `service_tier` and pass `settings: { features: { "service_tier": "<tier id>" } }` to `create_agent` or `update_agent`.

## Terminals

Use a terminal for a long-running or interactive process the user should be able to see, such as a dev server or a REPL. Use a script when `pimi.json` already defines the process.

**`create_terminal`** — `{ cwd?, name? }`. Opens a terminal in your working directory or `cwd`. Returns its `id`.

**`send_terminal_keys`** — `{ terminalId, keys, literal? }`. Sends text or one key token such as `Enter`, `Tab`, `Escape`, `Up`, or `C-c`. A command does not run until you send `Enter` in a second call. Set `literal: true` to send text that looks like a key token unchanged.

**`capture_terminal`** — `{ terminalId, start?, end?, scrollback? }`. Returns output lines as plain text. Set `scrollback: true` to read from the beginning.

**`list_terminals`** — `{ cwd?, all? }`. Lists terminals for one directory, or every directory with `all: true`.

**`kill_terminal`** — `{ terminalId }`. Kill the terminals you created when you are done with them.

## Browser

The `browser_*` tools drive tabs in the Pimi desktop app's browser. They exist only when the host has browser tools enabled, and they need a chat and a connected desktop app.

`browser_show` is the exception: it exists without that setting. It opens a URL beside the chat so the user can look at it and annotate elements back to you. It only shows the page; you get no content, `browserId` aside, and cannot click or read it. Use it when the user asks to see a page. Use `browser_new_tab` and the rest to work on a page yourself.

1. `browser_new_tab` with a URL, or `browser_list_tabs`, gives you a `browserId`. Pass it to every other browser tool.
2. `browser_snapshot` returns the page with element `ref`s.
3. Act on a `ref` with `browser_click`, `browser_fill`, `browser_type`, `browser_keypress`, `browser_select`, `browser_hover`, `browser_drag`, or `browser_upload`.
4. Take a new `browser_snapshot` after the page changes. Old `ref`s expire.

Use `browser_wait` for text or a URL to appear, `browser_screenshot` for visual checks, `browser_logs` for console and network entries, and `browser_evaluate` to run JavaScript in the page. Close tabs you opened with `browser_close_tab`.

## Automations and heartbeats

Pick by where the work runs:

- **Heartbeat** — a prompt sent back to you, in this conversation, later. It needs no approval and is deleted when you are archived. Use it to check on a build, pull request, or long job you started, or to remind yourself.
- **Automation** — new agents on every run, on a cron cadence, on GitHub pull request events, or by hand. It needs the user's approval and keeps running after this conversation ends. Use it for recurring work the user wants to keep.

**`create_heartbeat`** — `prompt` and exactly one of `cron`, `every` (30s at least), `in`, or `at`. Optional: `timezone` (with `cron`), `name`, `maxRuns`, `expiresIn`. A one-time heartbeat (`in`, `at`) waits for your turn to end. A recurring one that comes due while you are mid-turn fails that fire, and the fire still counts toward `maxRuns`, so pick an interval longer than your turns. To change a heartbeat, create it again with the same `name`. `list_heartbeats` shows yours. Call `delete_heartbeat` with the `id` once the thing it watches is finished.

**`create_automation`** — `name` and `prompt`, or `steps` and `edges` for a graph. Optional: `cron` and `timezone`, or `pullRequest` (`repo`, `events`); `provider`, `profile`, `cwd`, `workspace` (`project` folder or a fresh `worktree` per run), `maxRuns`, `expiresIn`. Omit `cron` and `pullRequest` for an automation that runs only by hand. With `profile`, each run's agent starts with that profile's instructions as they stand when the run starts, and `prompt` carries only the task.

- **Steps.** An agent step (`kind: "agent"`, `id`, `prompt`) runs a new agent; a condition step (`kind: "condition"`, `input`, `operator`, `value`) tests text. An edge `{from, to}` runs `to` after `from`; an edge leaving a condition needs `branch: "true"` or `"false"`. Steps with no path between them run at the same time, up to 3 agents per run. Reference an earlier step's final reply with `{{steps.<id>.output}}`. A failed step skips what depends on it; other branches keep going.
- **Pull requests.** The host's `gh` polls `repo` every minute. `opened`, `synchronize` and `review_requested` (from the `gh` user) fire once per head commit; pull requests open at approval wait until they change. Prompts read `{{trigger.number}}`, `{{trigger.url}}`, `{{trigger.headRef}}` and the other `{{trigger.*}}` fields the tool lists.
- **`update_automation`** — `id` and the fields to change; `prompt` or `steps` replace the whole flow. It returns the automation to `pending`.
- **`retry_automation_run`** — `id` and `runId` of a failed or cancelled run. Reruns the steps that did not succeed and reuses the outputs of those that did.

- It starts `pending` and does not run until the user approves it in the Automations screen. You cannot approve it. Tell the user it is waiting there; `run_automation_once` and `pause_automation` fail until they do.
- Each run's agent starts with no memory of this conversation and nobody to ask. Write the prompt as a complete brief: the task, what a finished result looks like, and what to leave alone.
- Runs use the provider's no-prompt mode when it has one, not the mode you are in. Without `provider` they use the profile's provider and model, or yours when there is no profile or it sets none; without `cwd`, your working directory. Set `workspace` to `worktree` when runs edit files.
- Creating one again with the same `name` replaces it and returns it to `pending`.

Cron is read in the host's time zone unless you set `timezone`, for both tools; the stored cadence records the zone it used. Set `timezone` whenever the user names a time in another zone.

After approval, `run_automation_once` starts a run without waiting for the cadence and returns while it is still running; read the result with `automation_runs`. A scheduled run is skipped, not queued, when the automation already has 2 runs going, has made 6 runs in the last hour, or the host has 4 automation runs going. `inspect_automation` shows each skip and its reason in the audit history. Three failed runs in a row pause the automation, and only the user can resume it. `pause_automation` stops one from firing. `delete_automation` removes only a pending one you created.

## Waiting

When you create or prompt a subagent, `notifyOnFinish` defaults to `true` and reports completion, errors, or permission requests, including across hosts.
Finish your turn and wait for that notification instead of polling.
To get the answer as a message instead, set `notifyOnFinish: false` and tell the agent to reply with `send_agent_prompt` to your `agentId`. For an agent on another host, also give it your `serverId` (`self` in `list_hosts`). It can reach you only when its own `list_hosts` shows your daemon; keep the default notification when it does not.

## CLI semantics

The CLI and tools use the same ownership semantics even where their syntax differs:

```bash
pimi chat create --isolation worktree --mode branch-off --new-branch fix-x --base origin/main
pimi chat create --isolation worktree --mode checkout-branch --branch existing-work
pimi chat create --isolation worktree --mode checkout-pr --pr-number 42
pimi run --provider codex/gpt-5.4 --mode full-access --chat <chat-id> "<prompt>"
pimi run --provider codex/gpt-5.4 --mode full-access --new-chat worktree --worktree-mode branch-off --new-branch fix-x --base origin/main "<prompt>"
pimi run --profile "Adversarial reviewer" --provider claude "<prompt>"
pimi send <agent-id> "<follow-up>"
pimi ls
pimi automation create --provider codex --cron "0 9 * * 1-5" --timezone Europe/Paris --name "Morning build check" "<prompt>"
pimi automation create --name "PR review" --pr owner/repo --pr-events opened,synchronize --flow flow.json
pimi automation compile "<plain-text description>" --save
pimi automation retry <automation-id> <run-id>
pimi automation steps <automation-id> <run-id>
pimi heartbeat create --every 15m "check the build"
pimi heartbeat create --in 20m "check whether CI finished"
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
