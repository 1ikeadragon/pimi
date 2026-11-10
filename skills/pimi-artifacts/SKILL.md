---
name: pimi-artifacts
description: Build custom interactive visuals in Pimi chat, such as simulators, maps, timelines, and explainers.
---

- Use a chart or Mermaid when it can answer the question. Build an HTML artifact when a slider, filter, comparison, or custom layout helps the user explore their data.
- Write one responsive HTML file in the workspace, 1 MB at most. Keep CSS, JavaScript, and any data it needs inside the file. Use the user's data when available, and label sample data.
- The file runs in a sandbox with no network, no storage, and no navigation. Remote scripts, fonts, images, and `fetch` fail, so inline everything.
- Pimi sets the page background, text color, and font to match the app. Style with these custom properties so the visual follows light and dark themes, and do not hardcode page or text colors: `--pimi-bg`, `--pimi-surface`, `--pimi-fg`, `--pimi-muted`, `--pimi-border`, `--pimi-accent`, `--pimi-accent-fg`, `--pimi-font`, `--pimi-mono`.
- The frame fits the content's height up to 640 px, then scrolls. Let the page flow at its natural height; do not size it with `100vh`.
- Show the file in chat with a `pimi-artifact` fence. Use its workspace-relative `.html` path with forward slashes. It runs inline when the reader reaches it and can also open in a workspace tab.

```pimi-artifact
{"title":"Latency explorer","path":"latency-explorer.html"}
```
