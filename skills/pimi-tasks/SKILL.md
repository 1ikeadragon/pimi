---
name: pimi-tasks
description: Track work on the Pimi board or delegate it to separate agents.
---

- Use `create_pimi_task` to track work without separate workers. Save the goal and limits in the brief, then continue in this chat.
- Use `list_pimi_labels` for existing labels and `list_pimi_repositories` for a clear repository match. Use `create_pimi_label` when the user asks for a new workspace label. Leave the repository blank when none is needed or the match is unclear.
- Use `propose_pimi_task` when the user wants to track delegated work on the board. Choose Chat for discussion or Git worktree for separate edits. Wait for the user to start the workers.
- When the user asks for another provider in this chat, use `create_agent` with `inheritContext: true` and a focused prompt. Bring the result back here.
- Use `list_pimi_tasks` and `get_pimi_task` to find an existing task, then `update_pimi_task` to change its details or stage.
