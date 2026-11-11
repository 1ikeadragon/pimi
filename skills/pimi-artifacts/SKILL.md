---
name: pimi-artifacts
description: Write a self-contained HTML visual for Pimi chat, such as a calculator, simulator, map, or explorer with its own controls, inline as a pimi-html block or as a workspace file. Use after pimi-visualize picks an HTML visual.
---

Use the **pimi-visualize** skill to decide whether the question needs HTML at all. A chart, table, or flow has its own block and should not be HTML.

## Inline or file

- Write the HTML inline in a `pimi-html` block. This is the default: nothing is written to the workspace, and the visual runs in the reply.
- Write a workspace file and show it with a `pimi-artifact` block only when the HTML is larger than the `pimi-html` limit in the system prompt, or the user asked for a file to keep.

```pimi-html
<title>Tip calculator</title>
<style>input{background:var(--pimi-surface);color:var(--pimi-fg);border:1px solid var(--pimi-border);border-radius:6px;padding:4px 8px}</style>
<label>Bill <input id="bill" type="number" value="40"></label>
<p id="tip"></p>
<script>
const bill = document.getElementById("bill"), tip = document.getElementById("tip");
const draw = () => { tip.textContent = "20% tip: $" + (bill.value * 0.2).toFixed(2); };
bill.addEventListener("input", draw); draw();
</script>
```

For a file, save one `.html` file of 1 MB at most and point at it with its workspace-relative path, using forward slashes:

```pimi-artifact
{"title":"Latency explorer","path":"latency-explorer.html"}
```

## Rules for both

- Give the document a `<title>`. Pimi shows it above an inline visual.
- The page runs in a sandbox with no network, no storage, and no navigation. Remote scripts, styles, fonts, images, and `fetch` fail, and so do `localStorage` and links to other pages. Put the CSS, JavaScript, and data in the document, and keep state in JavaScript variables.
- Pimi sets the page background, text color, and font, and gives the body 16 px of padding. Style everything else with these custom properties so the visual follows light and dark themes: `--pimi-bg`, `--pimi-surface`, `--pimi-fg`, `--pimi-muted`, `--pimi-border`, `--pimi-accent`, `--pimi-accent-fg`, `--pimi-font`, `--pimi-mono`. Do not hardcode a page or text color: black text disappears in the dark theme.
- Style form controls yourself with those properties. A browser's default input, select, and button are light even in the dark theme.
- The frame follows the content's height up to 640 px, then scrolls. Let the page flow at its natural height; do not size anything with `100vh`.
- Lay it out to fit 360 px wide with no sideways scroll: stack controls above the result, and give a drawing `width: 100%` with a `viewBox`.
- One idea per visual. Start every control at a realistic value, so the first render already answers the question, and update the result on every `input` event without a submit button.
- Draw charts inside the page as inline SVG or canvas. There is no chart library to load.
- Use the user's data when you have it, and write "sample data" on the page when the values are not real.
- Do not write three backticks anywhere inside a `pimi-html` block; they end the block.
