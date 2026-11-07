---
name: pimi-memory
description: Find or manage notes shared by Pimi agents across providers.
---

- Use `recall_project_memory` for repository facts and `recall_global_memory` for preferences across projects. Omit the key to list notes.
- Use `remember_project_note` or `remember_global_note` when the user asks to save a note. Keep repository details in project memory.
- Use `forget_project_note` or `forget_global_note` when asked to remove a note. Find its key first.
- Keep secrets and chat transcripts out of notes.
