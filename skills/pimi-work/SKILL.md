---
name: pimi-work
description: Use Pimi Work to find repositories, link worktrees to tasks, and label workspaces.
---

- Use `list_workspaces` for workspaces and their IDs. Use `list_pimi_repositories` for repositories Pimi can attach to tasks.
- Use `link_pimi_task_work` to attach an existing worktree to a task. Use `get_pimi_task` first. Attach the repository with `update_pimi_task` if needed.
- Use `list_pimi_labels` to find label names. Use `set_pimi_work_label` for a workspace, or `update_pimi_task` for a task.
- To start separate workers for a new task, call `propose_pimi_task` and wait for the user to start them.
