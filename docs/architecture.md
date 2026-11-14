# Architecture

Pimi is a client-server system for monitoring and controlling local AI coding agents. The daemon runs on your machine, manages agent processes, and streams their output in real time over WebSocket. Clients (mobile app, CLI, desktop app) connect to the daemon to observe and interact with agents.

Your code never leaves your machine. Pimi is local-first.

Daemon-owned outbound connections and routed API scope ownership are described in
[Connected hosts](connected-hosts.md).

## System overview

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Mobile App  │    │     CLI     │    │ Desktop App │
│   (Expo)     │    │ (Commander) │    │ (Electron)  │
└──────┬───────┘    └──────┬──────┘    └──────┬──────┘
       │                   │                  │
       │    WebSocket      │    WebSocket     │    Managed subprocess
       │    (direct or     │    (direct)      │    + WebSocket
       │     via relay)    │                  │
       └───────────┬───────┴──────────────────┘
                   │
            ┌──────▼──────┐
            │   Daemon    │
            │  (Node.js)  │
            └──────┬──────┘
                   │
      ┌────────────┼────────────┬────────────┬────────────┐
      │            │            │            │            │
┌─────▼─────┐ ┌───▼────┐ ┌──────▼─────┐ ┌────▼─────┐ ┌────▼────┐
│  Claude   │ │ Codex  │ │  Copilot   │ │ OpenCode │ │   Pi    │
│  Agent    │ │ Agent  │ │   Agent    │ │  Agent   │ │ Agent   │
│  SDK      │ │ Server │ │    ACP     │ │          │ │         │
└───────────┘ └────────┘ └────────────┘ └──────────┘ └─────────┘
```

## Components at a glance

- **Daemon:** Local server that spawns and manages agent processes and exposes the WebSocket API.
- **App:** Cross-platform Expo client for iOS, Android, web, and the shared UI used by desktop.
- **CLI:** Terminal interface for agent workflows that can also start and manage the daemon.
- **Desktop app:** Electron wrapper around the web app that bundles and auto-manages its own daemon.
- **Relay:** Optional encrypted bridge for remote access without opening ports directly.

## Packages

### `packages/server` — The daemon

The heart of Pimi. A Node.js process that:

- Listens for WebSocket connections from clients
- Manages agent lifecycle (create, run, stop, resume, archive)
- Streams agent output in real time via a timeline model
- Provides agent-to-agent tools through a transport-neutral tool catalog, with MCP as one adapter
- Optionally connects outbound to a relay for remote access

All paths are under `packages/server/src/`.

Desktop and CLI import server capabilities through explicit package subpaths such as
`@pimi/server/daemon-control`, `/configuration`, and `/process`. The root export
loads daemon bootstrap eagerly, even when a caller only uses a path or process helper.
Keep process-management and configuration dependencies independent of bootstrap and
WebSocket message schemas. Shared configuration schemas belong in protocol leaf modules;
`messages` imports and re-exports them. This prevents every supervising process from
retaining the daemon's runtime and wire-schema allocations.

Terminals do not live in the daemon process: their PTYs run in a detached terminal worker that
survives daemon restarts, crashes and upgrades. See [terminal-worker.md](terminal-worker.md).

Project identity is daemon-global rather than session-owned. After registry bootstrap, the daemon's
project Git observer keeps one non-recursive watch on each lexically equivalent active project root
and listens only for the root `.git` entry, with a slow rescan as a missed-event fallback. It runs
for empty projects and without connected clients, then fans metadata changes through the WebSocket
server to capability-aware sessions. It deliberately does not use the broad recursive working-tree
watcher or the per-session Git observer: those are checkout/status mechanisms and intentionally do
not retain non-Git directories.

Workspace git and forge runtime data belongs to one daemon-level, directory-keyed store.
Workspace descriptors, checkout diff subscriptions, and script metadata read the last known
snapshot from that store, so reconnecting clients receive it before refresh completes.
Refcounted git watches feed the store through snapshot-updated events; their lifetime controls
refresh only. Session cleanup and workspace archive retain the data. Removing the final active
workspace for a directory clears it. The store lives in memory and resets on daemon restart.

**Key modules:**

| Module                          | Responsibility                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `server/bootstrap.ts`           | Daemon initialization: HTTP server, WS server, agent manager, storage, relay   |
| `server/websocket-server.ts`    | WebSocket connection management, hello handshake, binary frame routing         |
| `server/session.ts`             | Per-client session state, timeline subscriptions, terminal operations          |
| `server/directory-sync/`        | Daemon-global latest-state sequences for projects, workspaces, and agents      |
| `server/labels/`                | Host-local label catalog, assignments, and explicit subscriptions              |
| `server/task/`                  | Tasks: the to-do records, links to chats, description generation               |
| `server/agent/agent-manager.ts` | Agent lifecycle state machine, timeline tracking, subscriber management        |
| `server/agent/agent-storage.ts` | Agent records in `$PIMI_HOME/pimi.db` (`node:sqlite`)                          |
| `server/agent/tools/`           | Transport-neutral catalog for workspaces, agents, permissions, and automation  |
| `server/agent/mcp-server.ts`    | Thin MCP adapter that registers the Pimi tool catalog with the MCP SDK         |
| `server/agent/providers/`       | Provider adapters (see "Agent providers" below)                                |
| `server/orchestration-skills/`  | Bundled catalog, host selection, convergence, and skill-directory transactions |
| `server/relay-transport.ts`     | Outbound relay connection with E2E encryption                                  |
| `server/automation/`            | Automations: triggers, runs, audit log, approval                               |
| `server/heartbeat/`             | Heartbeats: prompts sent back into one agent on a cadence or once              |

### `packages/protocol` — Wire schemas and shared protocol types

The source of truth for WebSocket messages, binary frame codecs, endpoint parsing,
agent timeline types, provider config schemas, and other values shared by daemon
and clients. Server, app, CLI, and `@pimi/client` all depend on this package;
it does not depend on the server.

### `packages/client` — Daemon client library and SDK facade

Owns the low-level daemon WebSocket driver plus the higher-level `PimiClient`
facade. App and CLI may import the low-level driver from
`@pimi/client/internal/daemon-client` during migration, while new SDK-shaped
code imports from `@pimi/client`.

`PimiApi` is the capability-only boundary over workspaces, agents, terminals, providers, and config.
`PimiClient` adds connection lifecycle. App plugin surfaces borrow an API over their selected
host's client; plugin subprocesses use the same facade over a host-owned IPC transport. `files`, `git`,
and `search` namespaces expose repository data to both. Plugins also change the app's own UI through
extension points; see [plugins](plugins.md#change-the-apps-ui). Protocol capability ownership and subscription lifetimes follow
[the client contract](protocol-compatibility.md#client-capability-ownership).

### `packages/app` — Mobile + web client (Expo)

Cross-platform React Native app that connects to one or more daemons.

- Expo Router navigation (`/h/[serverId]/workspace/[workspaceId]`, `/h/[serverId]/agent/[agentId]`, etc.). The `workspaceId` URL segment is an opaque workspace id, not a directly meaningful filesystem path.
- `HostRuntimeController` manages saved host connections, reconnection, and per-host runtime state. Direct TCP and relay connections use the ordinary client transport; desktop socket, pipe, and SSH connections cross one Electron-owned transport boundary. SSH only tunnels to an already-running daemon.
- `runtime/replica-cache` is typed storage behind the directory and timeline owners. It never observes or mutates `SessionStore`.
- `runtime/directory-sync` owns directory cache selection and network reconciliation. On demand it paints accepted rows for one host, then passes the persisted per-entity cursor through `project.list`, `fetch_workspaces`, and `fetch_agents`; the daemon returns each entity's latest projection when its sequence is newer, plus tombstones.
- `labels` owns one catalog-and-assignments replica per connected host, the deterministic cross-host projection that surfaces spanning hosts use (the filter page, the manager), and the per-host resolution a chip uses. Two hosts may give one name different ids and colors, so a chat, subagent or task resolves its labels against its own host's catalog and a merged answer would be wrong there. Catalogs never synchronize between hosts.
- `SessionContext` wraps the daemon client for the active session
- Composer UI and submit/draft behavior live in `packages/app/src/composer/`; screens and panels should integrate it from there instead of dropping composer internals into `components/`, `hooks/`, or `screens/workspace/`
- Timeline reducers in `timeline/session-stream-reducers.ts` handle compaction, gap detection, sequence-based deduplication
- Timeline sync correctness is documented in [docs/timeline-sync.md](timeline-sync.md): live streams are for immediacy, `fetch_agent_timeline_request` is authoritative, and catch-up is paged but complete.
- Voice features: dictation (STT) and voice agent (realtime)

Consumers request directory or timeline data without choosing memory, cache, or network. The owner
publishes an accepted cache hit and then reconciles it over the existing network path. A miss or an
invalid row uses that same path. Offline demand still publishes an accepted cache hit and defers
network reconciliation. Cache loading is demand-driven: opening a chat reads its agent row and
focused timeline row, plus the workspace and project rows needed by the route; opening a directory
reads directory rows for that host and establishes its live subscription when connected. Accepted
cached rows satisfy the same consumer-readiness projection as network rows. Host registry startup and
host connection do not create directory demand or install replicas. The directory owner retains
declared surface demand and re-establishes network reconciliation after reconnect; React does not
track connection generations. Late cache reads cannot replace state already advanced by live or
authoritative network data. Owners explicitly persist accepted commits; directory rows and their
checkpoint share one storage transaction. See
[data-model.md](data-model.md#replica-row-store)
for the storage shape and [timeline-sync.md](timeline-sync.md#client-replica-lifetime) for timeline
resume behavior.

The three directory entity types have independent monotonic sequences and share one daemon
generation. The daemon retains only the latest projection per entity and bounded tombstones, not an
event log. A missing, expired, or previous-generation cursor receives a full snapshot. Projects are
independent records; a project with no workspaces does not need a workspace placeholder.

Labels and tasks are not on the directory sequences. `label.list.request` with `subscribe` returns
the whole catalog and every assignment, then pushes `label.update` for that session; unsubscribed
sessions receive no label traffic. Tasks are fetched with `task.list.request` and refetched when the
daemon pushes `status.tasks_changed`. Both ride ordinary session auth, so a task tool works with
no desktop app open.

### `packages/cli` — Command-line client

Commander.js CLI with Docker-style commands. Common agent operations are also exposed at the top level (e.g. `pimi ls`, `pimi run`).

- `pimi agent ls/run/import/attach/logs/stop/delete/send/inspect/wait/archive/reload/update/mode`
- `pimi daemon start/run/stop/restart/status/reload/config/pair/set-password`
- `pimi terminal ls/create/capture/send-keys/kill`
- `pimi script ls/start/stop`
- `pimi automation create/update/compile/ls/inspect/pause/resume/approve/rm/run/retry/check/runs/steps`
- `pimi heartbeat create/update/delete/ls`
- `pimi project create/ls/rename/delete`
- `pimi chat create/ls/rename/archive`
- `pimi permit allow/deny/ls`
- `pimi provider ls/models`
- `pimi speech …`

Communicates with the daemon via the same WebSocket protocol as the app.

### `packages/relay` — Relay transport and E2E encryption

Enables remote access when the daemon is behind a firewall.

- Peers negotiate a Noise `NK` session with per-record counters. The client refuses the library's legacy NaCl `box` mode. [docs/relay-endpoint-security.md](relay-endpoint-security.md) owns the mapping, negotiation, and the `daemon.relay.requireProtectedSecurity` flag
- The relay is zero-knowledge — it routes encrypted bytes and cannot read content
- Client and daemon channels with identical API (`openClientSecureChannel`, `openDaemonSecureChannel`)
- Pairing via QR code transfers the daemon's public key to the client
- New homes keep relay disabled until pairing consent. `DaemonConfigStore` persists the desired state, while the relay runtime starts or stops the outbound transport live; pairing reads that current state instead of a startup snapshot.
- Optional E2EE capability negotiation preserves application frame kind: text plaintext uses base64 ciphertext text frames, while binary plaintext uses raw ciphertext binary frames
- Self-hosted relays opt into TLS with `daemon.relay.useTls` or `PIMI_RELAY_USE_TLS=true`; the public (client-facing) TLS setting can be overridden independently via `daemon.relay.publicUseTls` or `PIMI_RELAY_PUBLIC_USE_TLS`

The relay server is `packages/relay/src/node-relay.ts`, a self-hosted Node process behind a TLS reverse proxy; see [docs/self-hosted-relay.md](self-hosted-relay.md).

See [SECURITY.md](../SECURITY.md) for the full threat model.

### `packages/desktop` — Desktop app (Electron)

Electron wrapper for macOS, Linux, and Windows.

- Can spawn the daemon as a managed subprocess
- Native file access for workspace integration
- Same WebSocket client as mobile app

The desktop does not manage agent skills. It retains one compatibility reader for the old
`skill-selection.json`, imports that preference into its managed local daemon, then deletes the old
file after the daemon confirms persistence.

**Multi-window (hybrid land-on model).** `createWindow()` in `main.ts` is reusable: `⌘⇧N`/File→New Window, relaunching the app (`second-instance`), and the sidebar "Open in new window" action each open a fresh `BrowserWindow`. Every window shows the full sidebar — there is no per-window project ownership or filtering. "Land on a project" is delivered by a per-`webContents` `PendingOpenProjectStore`: each window pulls its own pending project path on mount (`pimi:get-pending-open-project`) and runs the normal open-project flow, identical to a CLI `pimi <path>` launch.

> **Window-state v1 limitation:** only the _first_ window of a session restores and persists saved geometry (size/position/maximized). Windows opened via ⌘⇧N / second-instance / "Open in new window" open at the default size, OS-cascaded, and do not persist — this avoids every window stacking on the same restored bounds and fighting over the single window-state store. Lifting this needs per-window state keys.
>
> **In-app browser profile.** Every browser guest uses one stable persistent Electron session, so cookies, authentication, cache, and site storage are shared across tabs, workspaces, and desktop windows and survive tab or app closure. Browser identity is independent of that storage partition: after every `did-attach`, the renderer explicitly registers its browser id, workspace id, and current guest `WebContents` id, and main accepts the registration only when that guest belongs to the calling renderer and the shared profile. Registration is intentionally repeated because reparenting a retained `<webview>` can replace its guest without replacing the DOM element. Settings > General > Clear browser data is the sole profile-deletion path; it clears the shared session and reloads live guests without deleting saved tabs or URLs.
>
> **In-app browser window opens.** Ordinary link opens, including Shift-clicked links, become Pimi workspace tabs. Script-created opens with popup features or a named window target and POST-backed opens remain secured Electron child windows in the shared browser profile, preserving `window.opener`, `postMessage`, named-window reuse, request bodies, and `window.close()` for OAuth, payment, and similar popup protocols. Unsupported URL schemes are denied before either path.
>
> **In-app browser ownership.** Each registered guest records its owning host window. The active browser is keyed by `(host window, workspace)`, and application-menu Reload / Force Reload resolve only within the window Electron supplies to the menu callback. A non-null active update must name a browser owned by that host; a null update clears only that host/workspace. Browser automation continues to target explicit browser ids returned by `browser_new_tab` or `browser_list_tabs`.

> **`browser_show`.** The one browser tool registered without `daemon.browserTools.enabled`. It rides the browser automation broker as a `show_tab` command but only puts a page beside the asking agent's chat; it returns no page content. With several desktop hosts the broker asks them newest first, one at a time, with `requireVisible`, so a page opens in the window that has the workspace on screen and never in two windows. If none has it on screen, the newest host opens it in that workspace's layout and the tool result says it is not on screen. A host that answers `show_tab` never takes keyboard focus.
>
> **Browser keyboard boundary.** Guest pages receive renderer-published shortcuts first. `Cmd/Ctrl+L` and `Cmd/Ctrl+R` are explicit guest-shell reservations; ordinary Pimi shortcuts run only after the page declines them. The sandboxed guest preload runs in every frame so focused iframes use the same boundary, while Node integration remains disabled. Human guest input disables Electron's menu fallback for plain keys. Agent-generated keys use guest `sendInputEvent` with `skipIfUnhandled`, so an unhandled Enter stops at the guest instead of reaching the host composer. Main selects the preload; it exposes no APIs to guest pages.

```text
Human key -> guest WebContents
  |-- Cmd/Ctrl+T/L/R ----------> reserved browser-shell action
  `-- page keydown
        |-- page prevents ------> page owns it
        `-- published shortcut -> guest preload -> IPC(browserId) -> Pimi resolver

Agent browser_keypress -> guest sendInputEvent(skipIfUnhandled)
  |-- guest handles ------------> page owns it
  `-- guest does not handle ----> stop; never redispatch to the host window
```

## WebSocket protocol

All clients speak the same WebSocket protocol over a single connection that mixes JSON text frames and a small binary framing for terminal streams. Schemas live in `packages/protocol/src/messages.ts`.

**Handshake:**

```
Client → Server:  WSHelloMessage {
                    type: "hello",
                    clientId,
                    clientType: "mobile" | "browser" | "cli" | "mcp",
                    protocolVersion,
                    appVersion?,
                    capabilities?: { voice?, pushNotifications?, ... },
                  }
Server → Client:  status message with payload { status: "server_info",
                    serverId, hostname, version, capabilities?, features }
```

There is no dedicated welcome message; the server emits one initial `status.server_info` after
accepting hello. Connecting or attaching a local listener creates no application-data
demand. A list is a snapshot; adding `subscribe: {}` creates an independent server ID. The client
correlates the initial reply by request ID, then routes updates by subscription ID.

A logical Session can contain several physical sockets. Each socket owns its capabilities,
subscriptions and ongoing operations; the final JSON/binary send boundary requires that source's
request or subscription provenance. Domain modules own filtering, bootstrap and resource teardown.
The shared ownership boundary only tracks source and lifetime. Releasing a subscription acknowledges
its teardown; reconnect creates new server IDs for surviving client handles. See
[protocol compatibility](protocol-compatibility.md#owned-observations).

**Top-level WS envelopes** are `hello`, `recording_state`, `ping`/`pong`, and `session` (which wraps the rich union of session messages).

Client liveness checks use the top-level JSON `ping`/`pong` envelope, not a session RPC or RFC6455 control ping. Current clients ping every 10 seconds, beginning one interval after connecting. The first ping claims an application-ownership lease for that physical socket, all later inbound activity renews it, and the daemon forcibly terminates the socket if the lease expires. A raw socket that never sends an application ping never enters this lease and is not closed for omitting one. Session RPC timeouts are operation failures, not proof that the socket is dead. A subscription bootstrap timeout closes its source to clear any unknown server-owned registration; the failed handle is released before other surviving handles reconnect.

Every physical send path enforces an 8 MiB outbound high-water mark, including JSON broadcasts, binary terminal frames, and the encrypted relay adapter's asynchronous queue. This sits above the terminal stream's 4 MiB soft backpressure threshold, leaving room for snapshot catch-up before the hard cutoff. JSON is serialized once per broadcast after sockets already at the limit are removed, then its exact byte length is checked for every remaining socket. A frame that would cross the limit is not sent; that physical socket is forcibly terminated without disturbing other sockets attached to the same logical session. Multiple tabs and simultaneous direct and relay paths may legitimately share a client id.

Client session RPC waits default to 60s so slow relay or mobile networks do not turn a live but delayed daemon response into a false operation failure. Keep connect timeouts, app-level grace windows, explicit diagnostic latency probes, liveness ping timers, and genuinely long-running RPCs separate from this default.

New session RPCs use dotted names with `.request` and `.response` suffixes, such as `checkout.forge.set_auto_merge.request` and `checkout.forge.set_auto_merge.response`. See [rpc-namespacing.md](rpc-namespacing.md) for the convention and migration rules for older flat RPC names.

**Notable session message types:**

- `agent_update` — Agent state changed (status, title, labels)
- `agent_stream` — New timeline event from a running agent
- `workspace_update`, `script_status_update`, `workspace_setup_progress` — Workspace state
- `agent_permission_request` / `agent_permission_resolved` — Tool-call permission flow
- `agent_deleted`, `agent_archived`, `agent_status`, `agent_list`
- `checkout_status_update`, `checkout_diff_update`, and the full `checkout_*` request/response set for git operations

Agent snapshots carry the daemon-owned active turn identity, and turn lifecycle stream events
carry the same `turnId`.

- Terminal subscribe/input/capture commands
- Voice/dictation streaming events (`dictation_stream_*`, `assistant_chunk`, `audio_output`, `transcription_result`)
- Request/response pairs for fetch, list, create, etc., correlated by `requestId`; failures use `rpc_error`

`directory_suggestions_request` is one daemon-owned filesystem search capability. The daemon
configures the same `searchDirectoryEntries` engine with a root, output format, path-query policy,
entry-kind filters, match mode, blank-query behavior, and hidden-directory traversal policy. A
request without `cwd` searches the host home for absolute project paths; a request with `cwd`
searches that workspace and returns relative entries. Clients may prepend their small host-scoped
recent-project list for bare queries, but must not parse filesystem query syntax or re-filter a
correlated daemon response.

**Binary frames (terminal stream protocol):**

Terminal I/O is sent as binary WebSocket frames decoded by `decodeTerminalStreamFrame` in `shared/binary-frames/terminal.ts`. The layout is:

- 1-byte opcode: `Output (0x01)`, `Input (0x02)`, `Resize (0x03)`, `Snapshot (0x04)`, `ReplayBegin (0x06)`, `ReplayData (0x07)`, `ReplayEnd (0x08)`
- 1-byte slot: terminal slot id
- variable payload: bytes for output/input, JSON-encoded `{ rows, cols }` for resize, terminal snapshot for snapshot

Terminal PTY size is last-interacting-client-wins. A client claims the PTY size only when its terminal viewport genuinely changes size or the user focuses/taps the terminal. Passive rendering work — attaching, restoring visibility, font settling, renderer refits, or just looking at a visible terminal — must not send a resize frame. The server does not broadcast resize ownership; the resized PTY redraws through normal output, and every attached client renders that output in its own local viewport.

There is also a separate file-transfer binary frame format in the same directory, used for download/upload streams.
File downloads keep the existing `FileBegin`/`FileChunk`/`FileEnd` framing and stream 256 KiB chunks
from one stable file handle. Each transfer awaits completion of its own physical WebSocket send before
reading the next chunk; it is scoped to the requesting physical socket and does not queue unrelated
messages or transfers.

### Compatibility rules

The app, CLI, plugins, and daemon ship together. See [protocol compatibility](protocol-compatibility.md) for how schema changes land.

### Creation ownership

Creation is owned by the daemon across socket lifetimes. A workspace request can include
its initial agent and prompt. Workspace readiness is published before provider startup;
the app keeps its existing disk-ready navigation and observes the remaining creation.
Callbacks do not advance the workflow. Resource reservations in acknowledgement are
identities, not ready workspace records.

The creation journal (`server/creation/`) owns identity and execution for creation RPCs. Requesting progress never selects a different journal. Message delivery receipts remain separate.
It keeps cumulative milestones and permanent IDs under an operation kind and idempotency
key. Reconnect subscribes to that key; retries
join active work or reuse committed stages. A persisted resource alone cannot prove
that a provider accepted its initial prompt. Interrupted side effects with no conclusive
receipt return an unknown outcome instead of being repeated.

Agent registration commits creation. Rejecting the first prompt is a turn error on that
agent; reporting creation failure leaves an orphaned agent and invites another Create.
Receipt replay must not resend the prompt.

`packages/client/src/creation/` owns keyed creation requests and their observation.
Callers always pass the initial prompt to agent creation.

Creation executes through the existing Session capabilities. Connection-owned delivery
controls observation only: detaching a socket or cleaning up its Session does not cancel
accepted creation. Updates require an explicit subscription and go only to that socket;
reconnect uses the shared subscription owner. Legacy consumers keep their existing response
contract.

## Agent lifecycle

The lifecycle states are defined in `shared/agent-lifecycle.ts`:

```
initializing → idle ⇄ running
        ↓       ↓        ↓
              error
                ↓
              closed
```

- `initializing` — provider session is being created
- `idle` — has a live session, awaiting the next prompt
- `running` — provider is currently producing a turn
- `error` — last attempt failed; session is still attached
- `closed` — terminal state, no live session

`ManagedAgent` is a discriminated union over those lifecycle tags. Notes:

- **AgentManager** is the source of truth for agent state and broadcasts updates to all subscribers
- Timeline sequence allocation is append-only with epochs (each run starts a new epoch). The one
  permitted in-place enrichment adds a provider message id to the manager-owned row for an accepted
  prompt; it preserves the row's sequence, content, and timestamp. Storage uses sequence numbers for
  client-side dedup; the default fetch page is 200 items.
- Timeline row `timestamp` values are canonical daemon-owned timestamps. Providers may supply original replay timestamps, but clients must not guess timestamp trust or hide time UI based on local clock heuristics.
- Events stream to connected clients in real time; correctness is backed by authoritative timeline fetches and paged-to-completion catch-up.
- Agent state persists to `$PIMI_HOME/agents/{cwd-with-dashes}/{agent-id}.json`. That storage path is derived from `cwd`, not from workspace id. Timeline rows are also written to `$PIMI_HOME/pimi-timeline.db`; see [Chat timelines and search](data-model.md#chat-timelines-and-search).

## Right-sidebar boundary: directory-backed vs workspace-owned

Two workspaces can share the same `cwd` (e.g. a `directory` workspace and a `local_checkout` workspace on the same folder, or several workspaces opened against one checkout). Model B keeps these distinct: they share everything the directory determines, but nothing the workspace owns. The right-sidebar surfaces split cleanly along this line, and the split is enforced purely by **what each piece of state is keyed by**.

**Directory-backed (shared by same-`cwd` workspaces) — keyed by `(serverId, cwd)`, never by `workspaceId`:**

| Surface                 | Key                                                      | Source                                                  |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| Git status              | `checkoutStatusQueryKey(serverId, cwd)`                  | `packages/app/src/git/query-keys.ts`                    |
| Git diff                | `checkoutDiffQueryKey(serverId, cwd, mode, baseRef, ws)` | `packages/app/src/git/query-keys.ts`                    |
| Forge change request    | `checkoutPrStatusQueryKey(serverId, cwd)`                | `packages/app/src/git/query-keys.ts`                    |
| Change request timeline | `prPaneTimelineQueryKey({ serverId, cwd, prNumber })`    | `packages/app/src/git/pull-request-panel/query-keys.ts` |
| File preview content    | `["workspaceFile", serverId, cwd, path]`                 | `packages/app/src/components/file-pane.tsx`             |
| File explorer listings  | fetched via `listDirectory(workspaceRoot, path)`         | `packages/app/src/hooks/use-file-explorer-actions.ts`   |

**Workspace-owned (independent per workspace) — keyed by `workspaceId` (falling back to `cwd` only when no `workspaceId` exists):**

| State                        | Key builder / store                                | Source                                                        |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| Review draft comments        | `buildReviewDraftKey`                              | `packages/app/src/review/store.ts`                            |
| Working diff comparison      | `workingDiffComparisonKey` (in-memory)             | `packages/app/src/git/working-diff-comparison/state.ts`       |
| Composer attachments         | `buildWorkspaceAttachmentScopeKey`                 | `packages/app/src/attachments/workspace-attachments-store.ts` |
| File explorer nav/open state | `fileExplorer` map keyed `workspace:{workspaceId}` | `packages/app/src/hooks/use-file-explorer-actions.ts`         |
| File explorer expanded paths | `expandedPathsByWorkspace[workspaceStateKey]`      | `packages/app/src/stores/panel-store/state.ts`                |

`diff-pane.tsx` is the canonical wiring site: it passes `{ serverId, cwd }` to the git queries and `{ serverId, workspaceId, cwd }` to the draft/comparison/attachment scope keys.

**Do not "fix" the sharing away.** Re-keying a directory-backed query by `workspaceId` makes same-`cwd` workspaces diverge (two windows onto the same git tree showing different diffs). Re-keying owned state (drafts, expanded paths) by `cwd` makes them leak between distinct workspaces on the same folder. The `workspaceId`-keyed builders carry a `// workspaceId is opaque; do not parse this key back into a path.` comment — the opaque-id fallback to `cwd` exists only for old payloads without a `workspaceId`, not as a content-sharing mechanism.

One deliberate non-violation: `AgentFileExplorerState.directories`/`files` cache directory listings inside the `workspaceId`-keyed explorer map. Same-`cwd` workspaces therefore keep duplicate caches, but they can never diverge — both fetch the identical directory via `listDirectory(workspaceRoot, …)`. This is duplication, not leakage, and is left as-is.

## Agent providers

Each provider implements the `AgentClient` interface in `agent/agent-sdk-types.ts`. Provider implementations live in `agent/providers/`.

The built-in, user-facing providers are Claude Code, Codex, Copilot, OpenCode, Pi, and OMP. Additional adapters exist in the same directory for ACP-compatible agents and internal use:

| Provider           | Wraps                                | Session format                                     |
| ------------------ | ------------------------------------ | -------------------------------------------------- |
| Claude (`claude/`) | Anthropic Agent SDK                  | `~/.claude/projects/{cwd}/{session-id}.jsonl`      |
| Codex              | Codex AppServer (`codex-app-server`) | `~/.codex/sessions/{date}/rollout-{ts}-{id}.jsonl` |
| Copilot            | GitHub Copilot via ACP               | Provider-managed                                   |
| OpenCode           | OpenCode server / CLI                | Provider-managed                                   |
| Cursor             | ACP wrapper (`acp-agent`)            | Provider-managed                                   |
| Generic ACP        | ACP wrapper                          | Provider-managed                                   |
| Pi                 | Local Pi RPC process                 | Provider-managed                                   |
| Mock load test     | In-process fake                      | In-memory                                          |

All providers:

- Handle their own authentication (Pimi does not manage API keys)
- Support session resume via persistence handles
- Map tool calls to a normalized `ToolCallDetail` type
- Expose provider-specific modes (plan, default, full-access)

Providers that can accept native tool definitions should set `supportsNativePimiTools` and read `launchContext.pimiTools`. The daemon then passes the shared Pimi tool catalog directly and removes the internal Pimi MCP server from that provider launch config. Providers that only support MCP continue to receive the same tools through the MCP fallback at `/mcp/agents`.

## Data flow: running an agent

1. Client sends `CreateAgentRequestMessage` with config (prompt, cwd, provider, model, mode)
2. Session routes to `AgentManager.create()`
3. AgentManager creates a `ManagedAgent`, initializes provider session
4. Provider runs the agent → emits `AgentStreamEvent` items
5. Events append to the agent timeline, broadcast to all subscribed clients
6. Tool calls are normalized to `ToolCallDetail` (shell, read, edit, write, search, etc.)
7. Permission requests flow: agent → server → client → user decision → server → agent

## Storage

`$PIMI_HOME` defaults to `~/.pimi`. The most important files:

```
$PIMI_HOME/
├── agents/{cwd-with-dashes}/{agent-id}.json   # Agent record
├── projects/projects.json                      # Project registry
├── projects/workspaces.json                    # Workspace registry
├── projects/icons/                             # Custom project icon images
├── automations/                                # Automation definitions, runs, audit log
├── heartbeats/                                 # Live heartbeats
├── config.json                                 # Daemon config (mutable)
├── daemon-keypair.json                         # Daemon identity for relay/E2EE
├── push-tokens.json                            # Mobile push tokens
├── pimi.pid                                   # Supervisor identity and published bound endpoint
└── daemon.log                                  # Daemon trace logs (rotated)
```

The supervisor alone publishes its ready worker's endpoint in `pimi.pid`, clears it before respawn, and fails if any worker exits before first readiness. CLI home selection trusts only that live record; config expresses desired state, never an endpoint fallback. POSIX home stop signals the captured supervisor without TCP. Windows graceful stop and ordinary RPCs trust the published endpoint. This metadata is not cryptographic listener ownership: edited endpoints, copied identities, PID reuse, and address takeover races remain outside that guarantee. A stale heartbeat never permits reclaiming a live lock.

Worker restart retains supervisor arguments/environment and rereads the configuration file. Updating a package and observing its new worker version do not refresh the running supervisor code; the launcher owns full-process replacement. See [CLI lifecycle contracts](../public-docs/cli.md#daemon-management).

## Outbound networking

The daemon and its plugin processes honor `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`
(including lowercase forms, which take precedence). Fetch and relay and connected-host WebSockets
share this policy. Loopback (`localhost`, `127.0.0.1`, `::1`) always goes direct.
A proxy without a scheme uses HTTP. Invalid values and unsupported proxy schemes
are treated as unset, with one warning naming the variable in `daemon.log`.
Agent and terminal environments are unchanged. System proxy settings and SOCKS-only
`ALL_PROXY` configurations are not supported.

Settings > Resources shows two sources (`diagnostics.resources.snapshot`). The first is the
daemon's own outbound requests, recorded from Node's diagnostics channels, so every fetch,
`node:http(s)` request, `ws` handshake, TCP socket, `dgram` send and `dns.Resolver` call in the
daemon process appears without call-site changes. Plugin processes, the speech worker and the
plugin compiler thread run the same hooks and report to the daemon. A request is labelled by the
host it went to; when you add a call site that reaches arbitrary hosts, wrap it in
`withNetworkInitiator` (`packages/server/src/server/network/activity.ts`). A purpose label never
makes a destination known; only a host rule or the owner's Trust does. Only method, host, port, and
path are recorded, never query strings, headers, or bodies.

The second is an OS sampler (`packages/server/src/server/resources/`) rooted at the supervisor and
daemon, the terminal workers, and the desktop app when it sends its pid. It reads `ps`/`lsof` on
macOS, `/proc` on Linux and one persistent PowerShell child on Windows, always through
`execFileUnobserved` so it never logs itself. It sees any program by pid but only connections open
when a sample runs, and names an address only from the daemon's own lookups and sockets plus a
forward lookup of known hosts. A watchdog subscribes with `ResourceMonitor.subscribe`. The owner-facing
limits are in `public-docs/resources.md`. Launches carry their agent through `withLaunchAgent`
(`utils/process-launch.ts`); wrap any new place that starts an agent's provider process in it.

## Deployment models

1. **Local daemon** (default): `pimi daemon start` on `127.0.0.1:6767`
2. **Managed desktop**: Electron uses the server package’s local-instance lifecycle capability for sanitized launch, published readiness, and captured-PID stop. Only a matching `{pid, startedAt}` from a spawn in the current Desktop session authorizes automatic stop. Preexisting instances are attach-only, with one exception at app start: a `desktopManaged` instance on a different version than the app is replaced by the bundled daemon while none of its agents is `initializing` or `running`, so a keep-running survivor does not stay on an old version across app updates. When an agent is working, or the agent list cannot be read, the instance stays attached and the sidebar offers a restart the user confirms. An instance the user started is never replaced. Explicit attached Stop requires a confirmation naming the captured home/PID. Ordinary Restart uses the worker RPC on every app platform.
3. **Remote + relay**: Daemon behind firewall, relay bridges with E2E encryption

## Daemon storage

The daemon owns one SQLite database, `$PIMI_HOME/pimi.db`, opened through built-in `node:sqlite`
(no native package; Electron 44 bundles Node 24). `server/db/pimi-db.ts` opens it with WAL and
`synchronous=FULL`, runs `PRAGMA integrity_check` (a failing file is moved aside, never deleted, and
the daemon starts empty), applies append-only schema steps tracked in `PRAGMA user_version`, and
copies it to `pimi.db.bak` with `VACUUM INTO` at most once a day. Only the daemon worker opens it for
writing; `pimi daemon db dump <table>` reads it read-only. Zod stays the schema authority: records
are parsed on read and before write, and each row keeps the record as JSON next to indexed columns.

In the database: agents (`agents`, `agent_persistence`), automations, runs, triggers, drafts,
heartbeats, attack runs and findings, carried timelines, projects, workspaces, tasks, labels and
label assignments (`records`, by kind), both audit logs (`audit`), creation and message receipts (`receipts`), sent-attachment
metadata and the image index. Still files: `config.json` and the small identity, secret and lock
files, image and attachment bytes, annotation images, network logs, Spaces and project memory.

Each migrated store imports its old JSON once, gated by a `meta` row (`imported_<name>`), and renames
what it read with a `.migrated` suffix. There is no dual write and no fallback reader; to go back,
restore the renamed files. The import runs after the `~/.paseo` home migration. Not done: a durable
timeline (rows still replay from the provider transcript) and cross-chat search.
