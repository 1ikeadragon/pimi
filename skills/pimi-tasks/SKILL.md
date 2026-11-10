---
name: pimi-tasks
description: Track work on the Pimi board or delegate it to separate agents.
---

- Use `create_pimi_task` to track work without separate workers. Save the goal and limits in the brief, then continue in this chat.
- Use `list_pimi_labels` for existing labels and `list_pimi_repositories` for a clear repository match. Use `create_pimi_label` when the user asks for a new workspace label. Leave the repository blank when none is needed or the match is unclear.
- Use `propose_pimi_task` when the user wants to track delegated work on the board. Set `mode` to `chat` for discussion or `worktree` for separate repository edits. Add up to four work items in `experiments`; when the user names a provider or provider/model for one, put it in that item's `provider`. Wait for the user to start the workers.
- For another agent's help in this chat without a board entry, use `create_agent` as described in the **pimi** skill.
- Use `list_pimi_tasks` and `get_pimi_task` to find an existing task, then `update_pimi_task` to change its details or stage.
