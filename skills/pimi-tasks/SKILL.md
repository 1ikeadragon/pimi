---
name: pimi-tasks
description: Track work on the Pimi board or delegate it to separate agents.
---

- Use `create_pimi_task` when asked to create or track a task. Save the goal and any limits in the brief, then continue in the current chat. Leave work items and reports out of tracking-only tasks.
- Use `list_pimi_labels` for existing labels and `list_pimi_repositories` for a clear repository match. Use `create_pimi_label` when the user asks for a new workspace label. Leave the repository blank when none is needed or the match is unclear.
- Use `propose_pimi_task` when the user wants separate agents. Choose Chat for separate research folders or Git worktree for repository edits. Wait for the user to start the workers. Their reports return to the task and the original chat.
- Use `list_pimi_tasks` and `get_pimi_task` to find an existing task, then `update_pimi_task` to change its details or stage.
