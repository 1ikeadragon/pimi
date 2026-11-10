---
name: pimi-artifacts
description: Build custom interactive visuals in Pimi chat, such as simulators, maps, timelines, and explainers.
---

- Use a chart or Mermaid when it can answer the question. Build an HTML artifact when a slider, filter, comparison, or custom layout helps the user explore their data.
- Write one responsive HTML file in the workspace. Keep CSS, JavaScript, and any data it needs inside the file. Use the user's data when available, and label sample data.
- Show the file in chat with a `pimi-artifact` fence. Use its workspace-relative path with forward slashes. Pimi offers a preview in chat and a workspace tab.

```pimi-artifact
{"title":"Latency explorer","path":"latency-explorer.html"}
```
