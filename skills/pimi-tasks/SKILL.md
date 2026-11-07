---
name: pimi-tasks
description: Draft and manage Pimi tasks. Use before substantial research, parallel investigations, or work the user wants tracked.
---

- Call `propose_pimi_task` before starting substantial research or tracked work. Put the goal, limits, and deliverable in the brief. Add separate work items when they can run independently.
- Use Chat for research and other work that can run in separate folders. Choose Git worktree for repository edits.
- The proposal opens a draft. Wait for the user to save it and start the workers. Ask for a click if the draft stays in chat.
- Find a saved task with `list_pimi_tasks` and read it with `get_pimi_task`. Use `update_pimi_task` for the changes requested. Use `list_pimi_repositories` before attaching a repository.
- Workers report to the original chat. Use their results to answer the request and update the task when asked.
