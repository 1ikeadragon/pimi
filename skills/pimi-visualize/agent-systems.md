# Drawing agent and LLM systems

Find the row that matches the question, then use the layout under its name. All of them are `pimi-view` blocks; none is Mermaid.

| The user asks                                                                        | Layout       |
| ------------------------------------------------------------------------------------ | ------------ |
| How the agents are organised: orchestrator and workers, subagents, who can call whom | Topology     |
| What the agents say to each other, a handoff, or one request from start to finish    | Exchange     |
| How one agent runs: model, tool calls, results                                       | Agent loop   |
| What happens when the context fills up                                               | Compaction   |
| What the agent remembers and where it is kept                                        | Memory       |
| The steps of a chain or pipeline: RAG, extract then verify, plan then execute        | Pipeline     |
| What happens when a step fails: retries, validation, guardrails, fallbacks           | Guarded step |

## Every layout

- When the question is about a codebase, read the code first and use its names for boxes, participants, and messages. For a general question, use the common names and start the title with "Typical".
- Keep the diagram to what the question asks: up to 8 boxes or 12 messages. Put the mechanism in each box's `detail`, not in more boxes.
- Draw two blocks only when the question has two parts, such as "how are they organised and what do they send".
- State the takeaway in the title: "The orchestrator alone talks to the user", not "Agent architecture".

## Topology

A flow, `direction` "down", with one lane per role in the order control passes: the caller ("User" or "Orchestrator"), then "Workers", then "Tools" or "Shared state" if the question covers them.

- One box for the orchestrator. One box per kind of worker, up to three; merge more into one box that lists them in `detail`. Do not draw one box per instance of the same worker.
- One edge from the orchestrator to each worker, labelled with what is handed over ("task brief", "file list"). Say what comes back in the worker's `detail`. Add a return edge only when the result goes somewhere other than the caller.
- A handoff, where control moves and does not come back, is an edge labelled "hands off" with the context that travels in the receiving box's `detail`.
- Set `kind` "user" on the caller, "agent" on the orchestrator and workers, "tool" on tools, and "data" on shared state.
- Set `tone` "warning" on the one box that is the bottleneck or the single point of failure, if the question is about that.

## Exchange

A sequence. Participants are the actors in the order the request first reaches them: user, orchestrator or app, each agent, model, tools. Use at most five; merge the tools into one "Tools" participant.

- A message is what is sent: the brief, the question, the tool call, the result. Leave out what an agent thinks or decides; if it matters, make it a message from the agent to itself.
- Set `reply` on every result that returns to its caller.
- Put work that repeats in a `group` named for when it stops ("Until the model stops calling tools"). Put work that runs side by side in a `group` named "In parallel".
- Put each failure path in its own `group` named for its condition, with `tone` "negative" on the message that reports the failure.

## Agent loop

A flow with a cycle, five boxes:

1. "Prompt and context" to "Model call".
2. "Model call" to "Run tools", labelled "tool calls".
3. "Run tools" to "Append results".
4. "Append results" back to "Model call". The layout draws this edge dotted.
5. "Model call" to "Final reply", labelled "no tool calls".

Add a box only for a stop condition the question asks about, such as a turn limit or a permission prompt, as a branch off "Run tools" or "Model call". To show one real turn with its actual calls, use the Exchange layout instead.

## Compaction

A table, then a flow.

- The table has one row per part of the context in the order it sits in the window (system prompt, tool definitions, pinned files, older turns, old tool results, recent turns) and the columns "Part", "After compaction" (kept, summarised, dropped), and "Why". This is the answer; the flow is the trigger.
- The flow has four boxes: "Context reaches the limit" (put the threshold in the label if you know it), "Summarise older turns", "Rebuild context", "Continue the turn". Set `tone` "warning" on the first.
- Show token counts only when you measured them or read them from the code or docs. Then draw before and after as two `progress` nodes against the window size, above the table.

## Memory

- For "what is stored where", a table with the columns "Store", "Holds", "Written when", "Read when", "Lives until", one row per store, shortest-lived first.
- For "how does memory flow", a flow with one lane per lifetime: "This turn" (context window), "This session" (plan, scratchpad, state), "Across sessions" (memory files, database, vector store). Label each edge "write" or "recall", and put what triggers it in the `detail` of the box it starts from.

## Pipeline

A flow with one box per stage, in order, and no lanes unless the stages have different owners (then one lane per owner, such as "Retrieval" and "Model").

- Label each box with the stage name and put "input to output" in `detail`.
- Label an edge only when what passes along it is not obvious from the two boxes.
- Draw a check as its own box with two labelled edges, "pass" and "fail".
- Past six stages, merge the stages the question is not about.

## Guarded step

A flow around the one step that can fail:

- The step, then a check box ("Validate output", "Guardrail").
- From the check: an edge labelled "pass" to the next step, and an edge labelled "fail" to a "Retry" box. Put the limit and the backoff in the Retry box's `detail`.
- From "Retry": an edge back to the step, which the layout draws dotted, and an edge labelled "limit reached" to the fallback or the error, with `tone` "negative".
- When the question is about timing, add a `pimi-vega` bar chart of the delay before each attempt, from the code's constants.
