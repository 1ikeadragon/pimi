---
title: CLI reference
description: "Pimi CLI reference: manage projects, workspaces, agents, plugins, scripts, schedules, daemons, and permissions from your terminal."
nav: CLI reference
order: 35
category: Orchestration
---

# CLI reference

The Pimi CLI lets you manage agents from your terminal. It's the same interface exposed by the daemon's API, so anything you can do in the app you can do from the command line.

> **Agent orchestration:** You can tell coding agents to use the Pimi CLI to spawn and manage other agents. Pimi recognizes the calling agent, so CLI-created workers get the same workspace and parent defaults as MCP-created workers.

## Quick reference

```bash
pimi run "fix the tests"            # Start an agent
pimi ls                             # List running agents
pimi attach <id>                    # Stream agent output
pimi send <id> "also fix linting"   # Send follow-up task
pimi logs <id>                      # View agent timeline
pimi stop <id>                      # Stop an agent
pimi usage                          # Show account quotas and balances
```

## Account usage

Show account quotas and balances from the host's usage sources:

```bash
pimi usage
pimi usage ls --refresh
pimi usage ls --agent <agent-id>
pimi usage inspect <report-id>
pimi usage inspect <report-id> --refresh
```

`pimi usage` is equivalent to `pimi usage ls`. The summary groups windows and balances by account, with report IDs, source and account labels, status, and fetch timestamps. Missing values appear as `-`; unavailable and failed reports include their reasons.

Copy the full report ID from the list into `inspect` to see reset times, balances and units, plan details, supplied forecasts, and login failures with recovery instructions. Report IDs require exact matches.

`--agent` selects the account quota associated with an agent. It does not measure that agent's token consumption or cost. Use the full agent ID, and do not combine `--agent` with `inspect`.

Queries use the host's five-minute cache when available. Add `--refresh` to bypass it. Use `--host` or `--home` to [select a daemon](#select-one-daemon). Hosts without usage-source support return an update message.

### Usage in scripts

```bash
pimi usage ls --json
pimi usage inspect <report-id> --json
pimi usage ls --quiet
```

List JSON is always an array, including `[]` when no reports are returned. Inspect JSON is one report entry. Each entry includes `id`, `sourceId`, `sourceLabel`, `account`, `fetchedAt`, and a nested `report`. Read `report.status` before accessing its data:

| Status        | Fields                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| `available`   | `windows`, with optional `planLabel`, `balances`, and `details`        |
| `unavailable` | `problem`, describing expired or rejected credentials or missing quota |
| `error`       | `error`, the failure message                                           |

Entries may also include `loginErrors`. Structured output preserves numeric values and optional fields. Standard `--format yaml`, `--no-headers`, and `--no-color` options are supported; `--quiet` prints full report IDs.

A completed query exits with status `0`, including when individual reports are unavailable or failed. Connection or request failures, unsupported hosts, unknown report IDs, and conflicting selectors exit with status `1` and write the error to stderr. Human output says **No usage reports returned** for an empty result; this does not establish whether account discovery succeeded for every source.

## Connected hosts

`--host` selects the daemon whose saved connections you manage. Registrations use their
`registrationId`, not their label.

```sh
pimi --host localhost:6767 host add 'ssh://deploy@build-box' --label build-box --meta team=infra
pimi --host localhost:6767 host ls --json
pimi --host localhost:6767 host inspect hst_123
pimi --host localhost:6767 host update hst_123 --meta team=tools --remove-meta obsolete
pimi --host localhost:6767 host update hst_123 --connection 'ssh://deploy@new-address'
pimi --host localhost:6767 host disable hst_123
pimi --host localhost:6767 host enable hst_123
pimi --host localhost:6767 host rm hst_123
```

Add accepts TCP/host-and-port, `ws://`/`wss://`, local socket/pipe, SSH, and relay/pairing URLs.
SSH connects to an already running daemon. Add `?password=...` to an SSH URI when that daemon requires a password (`&password=...` after `daemonPort`). Unreachable targets remain saved and retry automatically.
`ls` includes disabled and failed hosts. `inspect` includes safe connection details and recovery guidance.
JSON output never includes connection credentials.

`update --meta` replaces supplied keys; `--remove-meta` removes keys. Replacing a connection retains
the pinned daemon identity. Add `--replace-identity` with `--connection` only after verifying a changed
destination. `rm` removes the saved connection; agents and workspaces on that host keep running.

## Provider diagnostics

Ask the daemon to inspect the provider environment it actually uses:

```bash
pimi provider diagnostic claude
pimi provider diagnostic codex --json
pimi --host devbox:6767 provider diagnostic opencode
```

The diagnostic includes the configured command, daemon `PATH` and shell, matching binaries, resolved path, version, model count, and provider status. Use the global `--host` option for a remote daemon. This is the same diagnostic shown under **Settings → your host → Providers → provider → Diagnostic**.

## Running agents

Use `pimi run` to start a new agent with a task:

```bash
pimi run "implement user authentication"
pimi run --provider codex "refactor the API layer"
pimi run --no-wait "run the focused test suite"
pimi run --output-schema schema.json "name this branch"
pimi run --new-workspace worktree --worktree-mode branch-off --new-branch feature/x --base origin/main "implement feature X"
pimi run --workspace <workspace-id> "review the current diff"
pimi run --output-schema schema.json "extract release notes"
pimi run --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' "summarize release notes"
```

From a human shell, a bare `pimi run` creates a new local workspace for the current directory. Use `--workspace <id>` to add the agent to an existing workspace, or `--new-workspace local|worktree` to explicitly create a separate workspace for the run.

Worktree creation accepts `--worktree-mode branch-off|checkout-branch|checkout-pr` plus the matching `--new-branch`/`--base`, `--branch`, or `--pr-number`/`--forge` options. Use `--worktree-slug` to choose the managed directory slug.

When an existing Pimi agent runs the same command, Pimi recognizes it through `PASEO_AGENT_ID`. Without explicit placement, the new agent becomes its subagent in the same workspace. `--workspace` can place that subagent elsewhere without changing its parent.

Use `--output-schema` to return only matching JSON output. You can pass a schema file path or an inline JSON schema object. This mode cannot be used with `--no-wait`.

By default, `pimi run` waits for completion. Use `--no-wait` to return immediately while the agent keeps running, the same flag `pimi send` takes.

The old `run --background` and `-d` aliases still mean `--no-wait`. They are deprecated, hidden
from help, and print a warning to stderr. Use `--no-wait` in scripts. Workspace visibility is
selected separately with `workspace create --background`; this release does not repurpose
`run --background`.

## Projects

Register the current directory as a project, then list the projects known to the daemon:

```bash
cd ~/dev/my-app
pimi project create
pimi project ls
```

Use the project ID from `pimi project ls` to rename, reset, or delete a project:

```bash
pimi project rename <project-id> "My app"
pimi project rename <project-id> --reset
pimi project delete <project-id>
```

`--reset` restores the name derived from the project directory. Deleting a project archives its active workspaces and removes the project from Pimi. It does not delete the project directory.

For a local daemon, `pimi project create [path]` defaults to the current directory and resolves relative paths on the CLI machine. When you use the global `--host` option or `PASEO_HOST`, provide a path that the target daemon can access:

```bash
pimi --host devbox:6767 project create /srv/repos/api
```

The remote daemon interprets that path on its own machine. See [Workspaces](/docs/workspaces) for how projects group working directories and sessions.

## Workspaces

Create a workspace independently when you want to prepare its files before starting an agent:

```bash
pimi workspace create --isolation local --path ~/dev/my-app --title main

pimi workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode branch-off \
  --new-branch feature/auth \
  --worktree-slug feature-auth \
  --base origin/main

pimi workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode checkout-branch \
  --branch feature/existing \
  --worktree-slug existing-copy

pimi workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode checkout-pr \
  --pr-number 2186
```

Add `--background` to hide a workspace from default discovery. Its agents and terminals keep
ordinary history, persistence, hooks, and restart recovery. `--no-background` explicitly overrides
caller-workspace inheritance; omission inherits when run by a Pimi agent and defaults to false
from a human shell. Visibility is creation-only.

```bash
pimi workspace create --isolation local --background --path /path/to/repo
pimi run --workspace <workspace-id> --no-wait "review the checkout flow"
```

Exact workspace and agent IDs remain accessible regardless of listing visibility.

Then list, use, rename, or archive it:

```bash
pimi workspace ls
pimi workspace ls --background               # Also include background workspaces
pimi run --workspace <workspace-id> "implement authentication"
pimi workspace rename <workspace-id> "Auth rework"
pimi workspace rename <workspace-id> --reset   # back to the branch or directory name
pimi workspace archive <workspace-id>
```

Inside an agent session, `PASEO_WORKSPACE_ID` holds the agent's own workspace ID, so an agent can run `pimi workspace rename "$PASEO_WORKSPACE_ID" "Auth rework"` or `pimi workspace archive "$PASEO_WORKSPACE_ID"` even when other workspaces share its directory.

Add `--forge <name>` to PR checkout when Pimi cannot infer the forge from the source checkout. See [Git worktrees](/docs/worktrees) for setup hooks and services.

## Terminals

Use the workspace ID when multiple workspaces share a directory:

```bash
pimi terminal create --workspace <workspace-id> --name Development
pimi terminal ls --workspace <workspace-id> --json
pimi terminal send-keys <terminal-id> -l "echo ready"
pimi terminal send-keys <terminal-id> Enter
pimi terminal capture <terminal-id>
pimi terminal kill <terminal-id>
```

Creation defaults to the workspace directory. Add `--cwd <absolute-path>` to change the process directory while keeping that workspace as the owner. Unknown and archived workspace IDs fail.

Without `--workspace`, creation opens the project at `--cwd` or the current directory and reuses its oldest active workspace. Listing without `--workspace` filters by `--cwd` or the current directory and can include multiple workspaces. `ls --all` lists every terminal on the host and cannot be combined with directory or workspace filters.

Create and list results include `id`, `name`, `cwd`, and `workspaceId`. Use `--json` for structured output and the global `--host` option to target another daemon. These commands require a host that supports the [workspace terminal API](/docs/sdk/reference#clientterminals); older hosts return an update message.

## Workspace scripts

List, start, and stop the scripts configured in a workspace's `pimi.json`:

```bash
pimi script ls
pimi script start web
pimi script stop web
```

By default, Pimi selects the workspace whose directory is the current directory. Pass `--cwd <path>` to select a different directory, or `--workspace <workspace-id>` when a directory has multiple workspaces. Use the global `--host` option to target another daemon. These commands also accept standard output options such as `--json`.

The output includes each script's lifecycle and supervised terminal ID. Services also include their assigned port, proxy URL, and health. See [Git worktrees](/docs/worktrees#scripts-and-services) for `pimi.json` configuration.

## Plugins

> **Trust every plugin you add.** `pimi plugin add` and `pimi plugin install` mean “I trust this codebase.” Plugin server code and Git preparation commands run unsandboxed with the daemon user's access on the daemon host; client contributions run inside Pimi. Dependencies and future updates are part of that decision. With the global `--host` option, commands run on the remote daemon host.

Create and manage trusted plugins on a daemon:

```bash
pimi plugin init ./plugin
pimi plugin install ./plugin
pimi plugin add owner/slug
pimi plugin add git:owner/repository
pimi plugin add https://gitlab.com/group/repository.git --ref main
pimi plugin add git:owner/monorepo:plugins/review
pimi plugin ls [id]
pimi plugin update my-plugin
pimi plugin update --all
pimi plugin reload my-plugin
pimi plugin logs my-plugin
pimi plugin disable my-plugin
pimi plugin enable my-plugin
pimi plugin remove my-plugin
```

`pimi plugin reload <id>` reports the result of the reload itself: it waits while the daemon stops
and starts the plugin, however long that takes, and it queues behind the daemon's other plugin work.
Cancelling the command or losing the connection does not stop the daemon's work, and no listing or
log entry settles what a cancelled reload did — the [Plugin reference](/docs/plugins/reference)
covers those interim states. Running the reload again is what reports the result: it waits behind the
outstanding one, then stops and starts the plugin once more.

Bare `owner/slug` installs a reviewed registry listing. Use `git:owner/repository` for GitHub
source, or `./plugin` for a local directory. Append `:<directory>` for a plugin in a monorepo.

`pimi plugin ls [id]` does not contact the remote. `pimi plugin logs <id>` returns the
plugin's recent daemon-side stdout and stderr. Add `--json` for structured entries, or run
`pimi --host <target> plugin logs <id>` for another daemon. See the
[Plugin reference](/docs/plugins/reference) for installation, trust, lifecycle, and log-retention
behavior.

## Listing agents

```bash
pimi ls                    # Non-archived agents in active workspaces
pimi ls -a                 # Also include archived and background agents, with a BACKGROUND column
pimi ls -g                 # Non-archived agents across all workspaces
pimi ls -a -g --json       # All agents, including archived, as JSON
pimi ls --background       # Also include background agents and agents in background workspaces
```

## Streaming output

Use `pimi attach` to stream an agent's output in real-time:

```bash
pimi attach abc123   # Attach to agent (Ctrl+C to detach)
```

Agent IDs can be shortened, `abc` works if it's unambiguous.

## Sending messages

Send follow-up tasks to a running or idle agent:

Use the recipient's agent ID from `pimi ls`, or [copy it from the agent's tab](/docs/orchestration-workflows#send-a-prompt-to-another-agent).

```bash
pimi send <id> "now run the tests"
pimi send <id> --image screenshot.png "what's wrong here?"
pimi send <id> --no-wait "run this task"
pimi send <id> --behavior interrupt "stop and do this instead"
```

Agent-originated sends (`PASEO_AGENT_ID` set) default to steering the running turn. Other sends default to interrupting it. Use `--behavior steer` or `--behavior interrupt` to override the default. Steering uses the same fallback as the client: if steering is unavailable, the running turn is interrupted and replaced.

## Viewing logs

```bash
pimi logs <id>                  # Full timeline
pimi logs <id> -f               # Follow (streaming)
pimi logs <id> --tail 10        # Last 10 entries
pimi logs <id> --filter tools   # Only tool calls
```

## Waiting for agents

Block until an agent finishes its current task:

```bash
pimi wait <id>
pimi wait <id> --timeout 60   # 60 second timeout
```

Useful in scripts or when one agent needs to wait for another.

## Schedules

Run an agent on a cron schedule. The CLI also accepts simple cadence presets and compiles them to cron. See [Schedules from the CLI](/docs/schedules-cli) for the full reference.

```bash
pimi schedule create --every 30m --cwd ~/dev/my-app "Continue the refactor and leave a note."
pimi schedule ls
pimi schedule pause <id>
```

## Permissions

Agents may request permission for certain actions. Manage these from the CLI:

```bash
pimi permit ls                # List pending requests
pimi permit allow <id>        # Allow all pending for agent
pimi permit deny <id> --all   # Deny all pending
```

## Agent modes

Change an agent's operational mode (provider-specific):

```bash
pimi agent mode <id> --list   # Show available modes
pimi agent mode <id> bypass   # Set bypass mode
pimi agent mode <id> plan     # Set plan mode
pimi agent detach <id>        # Make a subagent top-level
```

Detaching is an explicit lifecycle action, not a creation flag. The agent keeps running; only its relationship to its parent changes.

## Daemon management

Define an instance once, then start its saved configuration:

```bash
pimi daemon config set daemon.listen 127.0.0.1:6799 --home ~/paseo-test
pimi daemon config set daemon.relay.enabled false --home ~/paseo-test
pimi daemon start --home ~/paseo-test
pimi project ls --home ~/paseo-test
pimi daemon restart --home ~/paseo-test
pimi daemon stop --home ~/paseo-test
```

`start` runs in the background and reports the actual listening address and supervisor PID. It accepts only home selection and `--timeout <seconds>` (default 600). If waiting times out, the supervisor remains running: use the printed status, log, and stop instructions. A worker that exits before becoming ready makes startup fail.

`restart` requests a replacement worker from the existing supervisor. It rereads the file and retains the supervisor's original environment and arguments. Success confirms a different ready worker, following a changed address for a home target. It never starts a stopped daemon or refreshes the supervisor binary. A timeout reports whether the request was acknowledged; it does not prove why reconnection failed.

`stop --home` waits for that local supervisor to exit. On POSIX it signals the supervisor without contacting a TCP endpoint. On Windows it uses the ready daemon's shutdown RPC; an unbound instance requires explicit `--force`. `--force` permits forced process-tree cleanup after the graceful timeout (default 15 seconds). `stop --host` only reports **shutdown requested**; remote process exit is not verified. A service manager may start another instance after the captured supervisor exits.

`status` separates local supervisor state, its published endpoint, the configured address, and RPC reachability. A stopped home is never probed at its configured address. An unbound live supervisor is **not ready**. If an authenticated local connection remains open but status details time out, the result stays `reachable` with a note explaining the unavailable details. Worker and provider fields are omitted. An explicit `--host` query still fails when its status request fails.

`reload` validates the file, applies runtime-safe changes, and reports `appliedPaths`, `restartRequiredPaths`, and `overrideControlledPaths`. It never implicitly restarts. Use `--json` or `--format yaml` for structured results. An older host lacking the capability reports that it needs an update.

The root aliases `start`, `status`, `restart`, `reload`, and `pair` use the same commands as `daemon`. Root `run` and `stop` remain agent operations.

### Foreground deployments and migration

Use environment overrides with the foreground deployment command:

```bash
PASEO_LISTEN=127.0.0.1:6799 PASEO_RELAY_ENABLED=false paseo daemon run --home ~/paseo-test
```

It stays attached until the supervisor exits or you cancel, without a readiness timeout. Worker restart retains these launch inputs. Stop and relaunch the deployment to change them. If the home already has a live supervisor, `run` returns `already_running` without owning or launching a foreground process.

Managed `start` ignores inherited daemon-setting overrides, including `PORT`, `PASEO_LISTEN`, relay, voice, and web UI settings. It preserves provider credentials and executable/runtime controls. `start --foreground` is removed; use `daemon run`. Former start/restart configuration flags such as `--port`, `--no-relay`, and `--web-ui` fail before side effects, with the corresponding `config set` migration. See [configuration edits](/docs/configuration#apply-changes).

### Select one daemon

Every daemon-connected CLI command accepts global `--home` or `--host`, before or after the command. A home selects a local supervisor's published endpoint; a host selects an explicit endpoint. There is no configured-address or default-port fallback.

| Selectors                                  | Result                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| `--home`                                   | That local home, overriding both environment selectors |
| `--host`                                   | That endpoint, overriding both environment selectors   |
| Both flags, or conflicting duplicate flags | `TARGET_AMBIGUOUS`                                     |
| Only `PASEO_HOME` or only `PASEO_HOST`     | The corresponding target                               |
| Both environment selectors, without a flag | `TARGET_AMBIGUOUS`                                     |
| Neither                                    | Default local home, `~/.paseo`                         |

Local-only `start`, `daemon run`, `config`, `onboard`, and `set-password` reject explicit `--host` and ignore `PASEO_HOST`. Endpoint operations retain TCP, Unix socket, Windows pipe, SSH, and pairing-offer transports. A host-side CLI controlling a container needs `--host` or `PASEO_HOST`.

## Hub

```bash
pimi hub login [url]          # Approve and store organization-scoped CLI access
pimi hub init                 # Create and optionally deploy a starter trigger here
pimi hub connect [url]        # Enroll this daemon using CLI access
pimi hub projects             # List legacy projects in the authenticated organization
pimi hub status               # Show the current Hub relationship
pimi hub permissions list     # Show what this Hub may do on this daemon
pimi hub permissions grant hub.execute    # Let Hub automations run agents here
pimi hub permissions revoke hub.execute   # Take it back
pimi hub disconnect           # End it
pimi hub deploy               # Validate and install .paseo/triggers/*.yml
pimi hub deploy --dry-run     # Validate without installing
pimi hub deploy -p <project>   # Deploy an existing legacy project bundle
pimi hub logout               # Remove the active stored CLI login
```

Run deploy from the repository root. By default it reads every direct `.paseo/triggers/*.yml` file in deterministic path order. It validates all triggers before installing them one at a time. If an installation fails after earlier ones succeeded, the error lists the installed files. `--dry-run` only validates; it does not create or activate revisions.

Pass `-p, --project <slug>` for an existing legacy bundle: `.paseo/hub.yml`, direct `.paseo/workflows/*.yml` files, and referenced workflow partials. See [Deploy from the CLI](/docs/hub/configuration#deploy-from-the-cli).

`login` opens the Hub approval page and stores a durable organization-scoped CLI credential under `PASEO_HOME`. In an interactive terminal it offers to connect this daemon, then separately asks whether to allow Hub automations to run agents. Connection defaults to yes; execution permission defaults to no. It then links to Hub's **Triggers** page and prints `pimi hub init` for setup as code. `--json` and non-TTY login remain login-only and never prompt. The stored login is separate from the daemon relationship created by `connect`.

`init` requires a TTY. It signs in and connects the daemon as needed, then lists the organization's app connections that can back a starter trigger. One usable connection is selected automatically; with several, you choose a **Trigger connection**. If none is ready, setup sends you to **Hub → Apps** and stops before selecting an agent or writing files.

Setup asks which agent provider, model, and mode to run. Providers must be enabled and expose both a selectable model and an execution mode. Suggested model and mode entries are the daemon's defaults; a mode is still selected explicitly when there is no default. Hub validates the choice against the daemon before deploying, and accepts only Claude, Codex, and OpenCode for its unattended runs. `deploy` applies the same checks, so it needs the named daemon connected. Setup then asks for the identity allowed to trigger the bot: a GitHub username, Slack member ID, or Discord user ID. It validates the trigger, writes `.paseo/triggers/<provider>-help.yml`, and asks whether to deploy. Replacing that file requires confirmation; existing legacy bundles and other trigger files are preserved. See the [generated starter trigger](/docs/hub/configuration#generated-starter-trigger).

Interactive logout checks the same-origin daemon relationship and asks whether to disconnect before deleting the login. Declining removes only the login. JSON and noninteractive logout never prompt or disconnect implicitly; `--disconnect-daemon` is the explicit automation path, and `--force` applies to that daemon disconnection. If a requested disconnection fails, the login is preserved.

Every command resolves and normalizes its destination before Hub or daemon work. Origin precedence is an explicit command origin or `--hub`, then `PIMI_HUB_URL`, then the active stored login origin. Credential precedence is `--api-key <secret>`, then `PIMI_HUB_API_KEY`, then a stored login for the exact resolved origin. A stored credential is never sent to a different origin. API keys passed through flags or the environment are not stored.

Human output reports the resolved destination before each action. JSON output keeps stdout machine-readable and includes the normalized Hub origin. Bundle diagnostics identify paths without printing configuration contents or credentials.

See [Daemons in Hub](/docs/hub/daemons), [Hub configuration](/docs/hub/configuration), and the [Hub public API](/docs/hub/api).

## Connecting to a remote daemon

The global `--host` option accepts either a local target (`host:port`, a unix socket, or a Windows pipe) or a pairing offer URL, the same `pimi://pair/#offer=...` link the mobile app uses for QR pairing. With an offer URL the CLI connects through the Pimi relay with end-to-end encryption, so you can drive a daemon on another machine without exposing it to the network.

Get an offer URL from the daemon you want to control:

```bash
pimi daemon pair          # prints the QR and link when relay is enabled
pimi daemon pair --relay  # enables relay without prompting
pimi daemon pair --json   # structured output; never prompts
```

Relay is off for new installations. A disabled relay returns a `RELAY_DISABLED` error; pass `--relay` to provide explicit consent. For a stopped home, pairing is labelled offline; `--relay` saves relay enablement and the offer includes a start instruction. A live but unreachable home never falls back to an offline identity. Relay pairing is end-to-end encrypted. See [Security](/docs/security).

Use it from anywhere:

```bash
pimi --host 'pimi://pair/#offer=eyJ2IjoyLC...' ls
pimi --host "$OFFER_URL" run "fix the failing tests"
```

You can also set it once via `PASEO_HOST` instead of passing `--host` on every command. An explicit flag overrides the environment variable.

## Multi-agent workflows

The CLI is designed to be used by agents themselves. You can instruct an agent to spawn sub-agents for parallel work:

```bash
# Agent A spawns Agent B and waits for it
agent_id=$(paseo run --no-wait --quiet --title api-agent "implement the API")
pimi wait "$agent_id"
pimi logs "$agent_id" --tail 5
```

Because Agent A's ID is present in the environment, Agent B is created as its subagent in the same workspace unless `--workspace` is specified.

Simple implement + verify loop:

```bash
# Requires jq
while true; do
  paseo run --provider codex "make the tests pass" >/dev/null

  verdict=$(paseo run --provider claude --output-schema '{"type":"object","properties":{"criteria_met":{"type":"boolean"}},"required":["criteria_met"],"additionalProperties":false}' "ensure tests all pass")
  if echo "$verdict" | jq -e '.criteria_met == true' >/dev/null; then
    echo "criteria met"
    break
  fi
done
```

This pattern enables hierarchical task decomposition, a lead agent can break down work, delegate to specialists, and synthesize results.

## Output formats

Most commands support multiple output formats for scripting:

```bash
pimi ls --json                # JSON output
pimi ls --format yaml         # YAML output
pimi ls -q                    # IDs only (quiet)
```

## Global options

- `--host <target>`, connect to a different daemon (`host:port`, unix socket, or `pimi://pair/#offer=...` for relay). See [Connecting to a remote daemon](#connecting-to-a-remote-daemon).
- `--json`, JSON output
- `-q, --quiet`, minimal output
- `--no-color`, disable colors
