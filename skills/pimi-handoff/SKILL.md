---
name: pimi-handoff
description: Pass the current work to another agent or provider. Use when the user asks to hand off, transfer, or have another agent take over this task.
user-invocable: true
---

# Hand off work

Use the user's request and current conversation to identify the receiving agent, assignment, and constraints. A handoff creates a subagent and reports its result in this chat. Create a Task only when the user asks to track the work.

## Choose the recipient

Read the **pimi** skill. Call `list_profiles` and read the profile notes. Honor the user's requested profile or provider/model; otherwise choose the profile that fits the assignment. Pass it as `profile` to `create_agent`. If no profile fits, discover available providers and models as described in **pimi**.

Use the current workspace unless the user requests another location. For a requested worktree, or parallel agents editing the same repository, call `create_workspace` with `isolation: "worktree"` first and pass the returned `workspaceId`.

## Assign the work

Call `create_agent` with:

- `title`: a short description of the assignment.
- `provider`: the selected provider/model.
- `initialPrompt`: what to do next, what is already done, relevant files, unresolved issues, acceptance criteria, and the user's constraints. Include only details that affect the work. Preserve investigate-only, no-edit, no-launch, and commit/publish boundaries explicitly.
- `inheritContext: true`: attach this chat when the recipient is on this host. The attachment is reference history and may be shortened; keep essential instructions in `initialPrompt`.
- `notifyOnFinish: true`: receive completion, error, or permission updates.

For another host, omit `inheritContext` and include the necessary context, decisions, and failed attempts in `initialPrompt`. Discover or create the destination workspace and pass both `serverId` and `workspaceId` as described in **pimi**.

## Follow through

Use the returned agent ID and workspace to link the receiving agent. Continue independent work while waiting for its notification; do not poll. When it finishes, report the result and any unresolved issue here. If it errors or needs permission, report that state without claiming completion.

The recipient remains a subagent until the user detaches it in the app. Do not use CLI or wire-level detach operations.
