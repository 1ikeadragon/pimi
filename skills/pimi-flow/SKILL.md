---
name: pimi-flow
description: Propose, save and run Pimi flows, reusable graphs of agent steps with judge gates. Use for repeatable benchmark or research work whose final outcome should happen only once criteria are met.
---

- A flow is a saved graph of agent steps and judge gates. It runs from a chat with `run_flow`, never on a schedule or trigger. Use an automation for scheduled work and a plain prompt for one-off work.
- Propose a flow when the user repeats the same multi-step procedure and the last step should only happen once something is verified, such as benchmarking several approaches and then writing a report. Do not save one without the user asking or agreeing.
- Run `list_flows` first. When the user types `/name args` or asks to run a flow, call `run_flow` with that name and the args as `input`. It returns a run id at once. Tell the user the flow started and carry on; the final output, or the last failing feedback when a check never passed (Not met), arrives in this chat as a message.
- `save_flow` stores a flow as waiting for approval. You cannot approve it. Tell the user it is in Library > Flows and that pressing Run on the flow's card in this chat approves and starts it. Saving again under the same name replaces your flow.
- Steps run in the chat's directory, in parallel when no path joins them. Each step's agent knows nothing of this conversation: write each prompt as a complete brief with exact file names. Use `{{input}}` for what the chat passes and `{{steps.<id>.output}}` for an earlier step's reply.
- Put a gate before any step that must not run on bad work. A gate is `kind: "gate"` with `criteria`, `retryFrom` (an earlier step id) and `maxAttempts` (1-5, default 3). A fresh judge agent inspects the real directory and files a pass or fail. On a fail the steps from `retryFrom` down to the gate run again with the judge's feedback; out of attempts, the run ends Not met and nothing after the gate runs.
- Write gate criteria a judge can check by reading files and running commands: name the file, the field and the number, for example "results/<idea>.json exists for every idea and has numeric time, mean_cost and recall, and recall is at least 0.8". Avoid taste words such as "good" or "thorough". Several short criteria beat one long one.
- Set `retryFrom` to the first step whose output the criteria depend on, so the retry redoes only what can fix the problem.
- If you are the judge of a gate, inspect the work yourself, then call `submit_verdict` exactly once with `pass` and `feedback`. Do not fix the work. Not calling it counts as a fail.
