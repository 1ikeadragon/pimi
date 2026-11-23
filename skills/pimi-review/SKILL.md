---
name: pimi-review
description: Open Pimi Review for changes in a worktree.
---

- Call `suggest_pimi_review` when the user asks to see a diff or changes are ready for their review.
- Give a short summary of what changed. The review link uses your current checkout. When you changed a different Git checkout, such as a repository inside a plain folder chat, pass its `path`. Use the worker's chat for changes in its checkout.
- The user opens the suggestion in Review, where they can read the diff, leave comments, and send a selection back to a chat.
