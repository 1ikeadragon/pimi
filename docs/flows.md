# Flows

A flow is a saved graph of agent steps and judge gates. It lives in Library > Flows, is host-wide (not tied to a project), and runs only from a chat. No schedule or trigger starts one. Use an automation for scheduled work.

## Shape

- Nodes and edges are the automation graph (`AutomationFlowSchema`). The editor is the automation editor in `kind: "flow"` (`packages/app/src/automations/automation-editor-model.ts`); `flows/flow-editor-screen.tsx` is its shell. The start node is a fixed Chat node, and trigger, cadence, project and limits do not exist.
- Step prompts may use `{{input}}`, the text after `/name`. Names are lowercase slugs (`FLOW_NAME_PATTERN`) because they are typed as slash commands.
- Storage is `pimi.db` (`flow`, `flow_run`), through `server/flow/store.ts`. Runs are pruned to the newest 30 per flow.

## Gates

A gate is a node, shared with automations: `{ kind: "gate", criteria, retryFrom, maxAttempts }`. The loop is a gate property, not an edge, so the graph stays acyclic.

- The judge is a fresh agent in the run's directory with the model settings of the step it checks (`retryFrom` when that is an agent, else the nearest agent step before the gate). It never takes that step's profile.
- It must call the run-scoped `submit_verdict` MCP tool. Only an agent with an open slot on `GateVerdictBoard` can file a verdict. A turn that ends without one, or a judge that errors, is a fail. Prose is never parsed.
- On a fail with attempts left, `retryFrom` plus every step between it and the gate go back to pending. `retryFrom` may also be the start (`GATE_RETRY_FROM_START`, "Start" in the editor): every step before the gate goes back, which is how a gate over parallel branches reruns all of them; a step id reruns only that step's path to the gate. The agents that already ran get "Check '<title>' failed: <feedback>. Fix it and report again." as their next message (`resumeAgentId`); they are not recreated.
- Out of attempts, the gate fails and the existing rule (a failed step skips its dependents) blocks everything after it. A flow run ends `not_met` when that is the only failure; an automation run ends `failed`.
- A gate can only judge what it can see in the directory. Write criteria that name files, fields and numbers.

## Runs

- `run_flow` (agent tool) starts a run in the invoking chat's cwd and workspace and returns `{ runId, status }` at once. Step and judge agents are children of that chat (`pimi.parent-agent-id`), so they show in its subagents track.
- A run an agent started (`source: "agent"`) reports back when it ends: the final output (or the last failing feedback, "Not met") is sent to the chat as a message that tells the agent not to repeat it. A run the owner started from a card (`source: "card"`) sends nothing, because its card shows the result as markdown. A cancelled run sends nothing.
- A flow an agent saved (`save_flow`) is unapproved. `run_flow` on it makes a run in `awaiting_approval`; the chat card's Run button calls `flow.approve` then `flow.run.retry`, which starts the same run record. `flow.run.retry` always restarts from the first step on the flow as it is now, in the same record, so a card keeps following it.
- Archiving the chat cancels its runs. On daemon restart, `running` runs are marked failed.
- Step agents run in the chat's workspace. Per-step worktrees are not supported.

## Chat

- Typing `/` lists flows with a "Flow" tag. Precedence on a name clash: built-in, plugin, flow, provider. Sending `/name args` in an existing chat calls `flow.run.prepare`: no message is sent and no agent turn runs. The daemon makes a run in status `ready` (`awaiting_approval` for an unapproved flow) with `source: "card"` and appends a finished `run_flow` tool call to the chat's timeline, which the chat draws as the run card. The card shows the graph, the input (editable when the flow has an input hint) and Start, which calls `flow.approve` then `flow.run.retry` with the edited input. The rewrite lookup reads the cached `flow.list` query, so it only applies to flows the menu already fetched. In a chat that does not exist yet (a new-workspace draft) the prompt is rewritten to "Run the flow `name` with this input: args" so the agent calls `run_flow`.
- The run card (`flows/flow-run-card.tsx`) draws the flow's graph read-only, laid out once per flow revision, and polls `flow.run.get` every 3 seconds only while the run is running. It draws the current flow, so a flow edited after the run shows its new graph over the old run's steps.

## Reaching the screens

The Library sidebar section is desktop-only. The Flows library route (`/pimi-library?section=flows`) also opens in a browser and on a phone, where no sidebar row leads to it yet.
