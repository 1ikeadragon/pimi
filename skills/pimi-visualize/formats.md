# Block formats

Generated from the block parsers by `packages/protocol/scripts/generate-visualize-formats.mjs`. Do not edit by hand.

Pimi chat draws four kinds of visual block. When a reply holds three or more numbers that compare, trend, break down into shares, or relate to each other, draw them when the user asked for a chart or you are about to send a table of them. The chart stands in for a table of the same values: add a table beside it only for columns the chart does not show. Chart the numbers that answer the question, and do not count files or lines only to have something to chart. Choose the block by what is shown, and use the first that fits:
1. A chart of numbers (trend, comparison, ranking, distribution, share, or relationship): a pimi-vega block.
2. Headline metrics, a table of records, progress against a limit, a flow, pipeline, architecture, call path, dependency graph, or state machine, or a sequence of messages between participants: a pimi-view block.
3. Something the user operates, such as a calculator, simulator, or explorer with sliders, inputs, or toggles: a pimi-html block.
4. A gantt chart of dated work: a mermaid block. Mermaid is the last resort, for a gantt chart or when the user asks for Mermaid by name. Draw a sequence diagram, state machine, flowchart, or graph as a pimi-view block: Pimi shrinks a Mermaid diagram to fit the chat column and a box 480 px tall, so its text cannot be read on a phone.
Write the block straight into the reply as a fenced code block with that name, holding only what the block takes: no comments, and no code fence inside it. Say one or two numbers in a sentence instead of drawing them.
In any table, Markdown or block, the first column is the name and the second is the figure the user asked about: a phone shows four columns and hides the rest behind a sideways scroll.
Chat does not render math, and a pimi-html block cannot load KaTeX or MathJax. Write formulas as plain text with Unicode symbols, such as pᵢ = e^(zᵢ) / Σₖ e^(zₖ) and ∂L/∂zᵢ = pᵢ − yᵢ, never as LaTeX with $, \frac, or \sum.
When the user asks for colors that would not show on one of Pimi's light and dark themes, such as dark colors only, keep the theme's colors and say in one sentence that the chart follows the reader's theme so it stays readable in both.
Take every figure in a block from the output of a command, not from arithmetic in your head, or put "sample" in the title. Make the title state the finding, with its unit and time range. For a dashboard, or when two forms could fit, read the pimi-visualize skill first.
Before you draw how an agent or LLM system works (agents talking to each other, subagents or handoffs, the agent loop, tool calls, context compaction, memory, a multi-step pipeline, retries or guardrails, a request lifecycle), read agent-systems.md in the pimi-visualize skill and use the layout it gives for that case.

pimi-vega holds one Vega-Lite v6 spec as JSON:
```pimi-vega
{"title":"Pro revenue passed Free in March 2026","data":{"values":[{"month":"Jan","plan":"Free","usd":410},{"month":"Jan","plan":"Pro","usd":280},{"month":"Feb","plan":"Free","usd":430},{"month":"Feb","plan":"Pro","usd":390},{"month":"Mar","plan":"Free","usd":440},{"month":"Mar","plan":"Pro","usd":520}]},"mark":"line","encoding":{"x":{"field":"month","type":"ordinal","sort":null,"title":null},"y":{"field":"usd","type":"quantitative","title":"Revenue (USD)"},"color":{"field":"plan","type":"nominal","title":null}}}
```
- Put the rows inline in data.values, one object per row: up to 2000 rows and 65536 characters for the block. Aggregate or sample larger data first.
- Give raw rows and let the spec do the math with "aggregate", "bin", "stack", or "transform". For a distribution, use mark "bar" with x {"bin": true} and y {"aggregate": "count"}.
- To compare several measures per item, write one row per item and measure, then use "color" with "xOffset" for grouped bars.
- On a line, "color" draws a separate line for each value of its field. To mark some points on one line, such as the failed runs, use "layer": the line, then a "point" mark with a "transform" that filters to those rows.
- A ranking holds up to 12 bars. Keep the largest and sum the rest into one "Other" row.
- Set "type" on every field. Add "sort": null to keep the row order, such as months.
- Leave out "$schema", "width", "config", colors, and fonts. Pimi fits the width and applies its theme, and tooltips are already on.
- The chart cannot load anything. A "url" or "href" property anywhere in the spec makes the block fail.

pimi-view holds JSON with a title and one root node. Nodes nest, for example metrics above a table:
```pimi-view
{"id":"build","title":"Build is healthy; two slow suites","root":{"type":"stack","children":[{"type":"grid","columns":2,"children":[{"type":"metric","label":"Pass rate","value":"98%","delta":"+2%","tone":"positive","hint":"vs last week","trend":[91,94,96,98]},{"type":"metric","label":"Median time","value":"4m 12s"}]},{"type":"progress","label":"Coverage against the 80% goal","value":71,"max":80},{"type":"table","columns":[{"label":"Suite"},{"label":"Time (s)","align":"end"}],"rows":[["e2e",148],["integration",96]]}]}}
```
A flow node lays its boxes out for you. Give each box a short id and the name the code uses as its label, put the explanation in detail, set kind to what the box is (it picks the icon and colour), and group boxes into lanes by layer or owner. Label an edge with a short verb for what it does, such as "calls", "writes", or "reads from". A phone fits three boxes side by side: when more than three boxes feed or follow the same box, keep the two that matter and merge the rest into one box that lists them in its detail:
```pimi-view
{"id":"request-path","title":"A request passes auth before the handler","root":{"type":"flow","lanes":[{"id":"edge","label":"Edge"},{"id":"app","label":"App"}],"nodes":[{"id":"router","label":"router.ts","lane":"edge","kind":"code"},{"id":"auth","label":"checkAuth","lane":"edge","kind":"secret","detail":"Rejects expired tokens with 401"},{"id":"handler","label":"handleRequest","lane":"app","kind":"service"},{"id":"login","label":"Login page","lane":"edge","kind":"user","tone":"warning"}],"edges":[{"from":"router","to":"auth","label":"calls"},{"from":"auth","to":"handler","label":"passes"},{"from":"auth","to":"login","label":"redirects"}]}}
```
For a state machine, make each state a box and each transition an edge labelled with its event.
A sequence node draws the messages between participants in time order, one column per participant. Use it when the order of the exchange is the point, such as a handshake or a request lifecycle, and a flow when the shape of the system is the point. Copy each participant name and message text as the source writes it, with no escaping; a long message wraps. A phone fits five participants:
```pimi-view
{"id":"login","title":"Login retries a wrong password before it fails","root":{"type":"sequence","participants":[{"id":"app","label":"App"},{"id":"api","label":"API"},{"id":"db","label":"Database"}],"steps":[{"from":"app","to":"api","label":"POST /login"},{"from":"api","to":"db","label":"SELECT user"},{"from":"db","to":"api","label":"row","reply":true},{"from":"api","to":"api","label":"verify password hash"},{"group":"Wrong password, up to 3 tries","steps":[{"from":"api","to":"app","label":"401 retry","reply":true,"tone":"warning"},{"from":"app","to":"api","label":"POST /login"}]},{"note":"The password never reaches the database"},{"from":"api","to":"app","label":"200 session token","reply":true,"tone":"positive"}]}}
```
Each node is an object with a "type" and these fields:
- stack: children; optional direction "column" (default) or "row"
- grid: children; optional columns 1-4 (default 2), fewer when narrow
- section: title, children
- metric: label, value (string); optional delta (string), tone, hint, trend (numbers drawn as a sparkline)
- table: columns [{label, optional align "start" or "end"}] with distinct labels, rows of strings or numbers, one cell per column
- progress: label, value, max; optional tone
- text: content; optional tone, emphasis "normal", "strong" or "subtle"
- badge: label; optional tone
- flow: nodes [{id, label, optional detail, lane, kind, tone}], edges [{from, to, optional label}] naming node ids; optional direction "right" (default) or "down", lanes [{id, label}]. A kind is one of step, user, agent, service, data, file, queue, tool, code, external, secret. Cycles are allowed; an edge from a node to itself is not
- sequence: participants [{id, label}] in column order, steps in time order. A step is a message {from, to, label, optional reply (true draws a dashed return arrow), tone}, a note {note}, or a group {group, steps}: a labelled frame around a loop, an optional part, or one branch of an alternative. from and to name participant ids and may be the same participant
A tone is one of neutral, positive, negative, warning. Every text field is plain text: no Markdown, HTML, links, images, or colors.
Limits: 48 nodes, 5 levels, 12 children per node, 8 table columns, 50 table rows, 60 trend points, 120 characters per title, 64 per label, 32 per metric value, 120 per table cell, 1000 per text, 32768 for the block. A flow holds up to 24 boxes, 40 edges, and 6 lanes, with 48 characters per box label, 24 per edge label, and 240 per detail. Every edge must name two different boxes by id. A sequence holds up to 6 participants and 30 steps counting every message, note, and group, with 96 characters per message and 160 per note; a group can hold groups, one level deep.
To update a pimi-view block within the same reply, send another complete block with the same id.

pimi-html holds one HTML document or fragment, up to 131072 characters. Pimi runs it inline and shows its <title> above it:
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
- It runs in a sandbox with no network, storage, or navigation. Remote scripts, styles, fonts, images, and fetch all fail, so write the CSS, JavaScript, and data inline.
- Pimi sets the page background, text color, and font. Style everything else with these custom properties so it follows light and dark themes, and never hardcode a page or text color: --pimi-bg, --pimi-surface, --pimi-fg, --pimi-muted, --pimi-border, --pimi-accent, --pimi-accent-fg, --pimi-font, --pimi-mono.
- Start every control at a realistic value, so the first render already shows an answer. Lay it out to fit 360 px wide, and let the page take its natural height: no 100vh.
- Data larger than the limit: aggregate or sample it into the block and say so in the title. Never save HTML to the workspace to get around the limit. Only when the user asks for a file to keep, save one .html file in the workspace and show it with a pimi-artifact block holding {"title":"...","path":"its-workspace-relative-path.html"}.
