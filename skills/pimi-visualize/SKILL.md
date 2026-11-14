---
name: pimi-visualize
description: Draw a chart, dashboard, diagram, table, or interactive visual (an explorer, calculator, simulator, or what-if sliders) inline in Pimi chat as a pimi-vega, pimi-view, or pimi-html block, never as a project file. Use for any request to visualize, chart, plot, diagram, compare, "show me", or "build an interactive X explorer/calculator/simulator", and before sending a table of numbers.
---

The formats section at the end of this file gives each block's format, an example, and its limits. This skill decides which block to use and what goes in it.

To draw how an agent or LLM system works, read `agent-systems.md` beside this file first: it gives the block and the layout for each common case.

## Before you draw

Answer these silently. Do not print them.

1. **Question.** What is the user trying to find out, and what will they do next? "Is the build healthy" needs a verdict first. "Why is it slow" needs the biggest contributor first.
2. **Takeaway.** Write the one sentence the visual must show. That sentence becomes the title. If you cannot write it, read more data before drawing.
3. **Data.** Get values where they are produced: run the command, read the log, parse the file, count the rows. Do not chart numbers from memory, from an earlier summary in the chat, or estimated by eye. If you cannot get real values, put "sample" in the title.
4. **Reader.** The chat column is narrow and may be a phone. Put one idea in one block. A second idea is a second block or a sentence.
5. **Proof.** Choose one figure the user can check against the source, such as a total, a row count, or the latest value, and make sure the visual shows it.

## Pick the block

Use the first row that answers the question. Go to a later row only when an earlier one cannot.

| The user wants                                                        | Block                                                             | How                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One or two numbers ("what's the p95")                                 | A sentence                                                        | No block. Give the number, its unit, the time range or sample size, and what it compares to.                                                                                                                                                                                       |
| A few values compared, or a ranking                                   | `pimi-vega`, mark `bar`                                           | Category on `y` with `"sort": "-x"`, value on `x`, so long names stay readable. Keep the top 8 and sum the rest into one "Other" row. Past 12 items, or when exact values matter, use a `pimi-view` table.                                                                         |
| Change over time                                                      | `pimi-vega`, mark `line`                                          | Time on `x` as `temporal` (ISO dates) or `ordinal` with `"sort": null`. Use mark `bar` for fewer than six periods.                                                                                                                                                                 |
| Several series over time                                              | `pimi-vega`, mark `line` with `color`                             | One row per date and series. Up to seven series; past that, keep the largest and sum the rest as "Other".                                                                                                                                                                          |
| Several measures for a few items (3 frameworks, 4 metrics)            | `pimi-vega`, mark `bar` with `color` and `xOffset`                | One row per item and measure. Put the measure on `x`, the item on `color` and `xOffset`. When the measures have different units, use a `pimi-view` table instead: one shared axis would mislead.                                                                                   |
| Parts of a whole                                                      | `pimi-vega`, mark `arc`                                           | `theta` for the value, `color` for the part, `"innerRadius": 60` for a donut. Up to five parts. To compare shares between groups, use a stacked bar with `"stack": "normalize"`.                                                                                                   |
| A distribution                                                        | `pimi-vega`, mark `bar` with `"bin": true`                        | Give the raw values, one row each; `x` is the binned field and `y` is `{"aggregate": "count"}`. Name the median or p95 in the title. Above the row limit, bin the data yourself and plot one bar per bin.                                                                          |
| A relationship between two measures                                   | `pimi-vega`, mark `point`                                         | One row per item. Title both axes with units. Say in the sentence whether they move together.                                                                                                                                                                                      |
| Two dimensions at once (hour by weekday)                              | `pimi-vega`, mark `rect`                                          | Both dimensions `ordinal`, the value on `color` as `quantitative`.                                                                                                                                                                                                                 |
| Several headline figures (build health, cost, usage)                  | `pimi-view` metrics                                               | Two to four metrics that answer the question, then a table of the detail. Put a chart of the same data in its own `pimi-vega` block after it.                                                                                                                                      |
| Records to scan or sort                                               | `pimi-view` table; Markdown table when cells need links or code   | Write numbers as numbers and put the unit in the column label, so sorting works. Order rows by the column that answers the question.                                                                                                                                               |
| A value against a limit (budget, quota, coverage goal)                | `pimi-view` progress                                              | `value` and `max` in the same unit, with the unit in the label.                                                                                                                                                                                                                    |
| A process, pipeline, architecture, call path, or dependency graph     | `pimi-view` flow                                                  | Name boxes as the code does and put what each one does in `detail`. Set `kind` on each box. Group boxes into lanes by layer or owner. Label edges with a short verb. Up to 24 boxes; split a larger system into an overview and one detail flow.                                   |
| Messages between participants in order (handshake, request lifecycle) | `pimi-view` sequence                                              | One participant per system or actor, in the order the exchange first reaches them, up to five. Copy message text from the source. Set `reply` on returns, `tone` on the error, and put a retry loop or each branch of an alternative in a `group`. Past 30 steps, split it in two. |
| A state machine                                                       | `pimi-view` flow                                                  | One box per state, one edge per transition, labelled with its event. Set `tone` on the failure states.                                                                                                                                                                             |
| A timeline or plan                                                    | Mermaid `gantt` for dated work; a numbered list for ordered steps | Give every dated item a start and a length. Steps without dates read better as a list. This is the only diagram to write in Mermaid, unless the user asks for Mermaid by name.                                                                                                     |
| To try inputs: an explorer, calculator, what-if sliders, filters, a simulator | `pimi-html`                                                       | Write it inline in the reply, never as a file, unless the user asked for a file. Use it only when the user would change an input. Follow "Writing a pimi-html block" below.                                                                                                                                                                                         |
| A map, or a layout no other block can express                         | `pimi-html`                                                       | Draw it as inline SVG. Follow "Writing a pimi-html block" below.                                                                                                                                                                                                                   |

Two approaches compared on qualities, not numbers, go in a `pimi-view` table with one row per criterion and one column per approach, then a sentence that names the pick. Its cells wrap, so the criterion and both approaches fit a phone; a third approach scrolls sideways.

## Charts

- Write the title as the finding, with its number and time range: "Test time rose 38% after run 412", not "Test time by run". A reader who sees only the title should get the answer.
- Write rows in long form: one object per observation, with a column for the series name. Do not make one column per series.
- Title each axis with its unit, or set `"title": null` when the labels already say what they are.
- Sort bars by value. Keep the given order with `"sort": null` only when the categories have their own order, such as dates, versions, or size ranges.
- A bar's axis starts at zero. When the change is small next to the level (480 ms to 495 ms), chart the difference or the percent change from the first value, and say so in the title.
- Stack bars or areas only when the parts add up to a total the user cares about. To show how each series moved, draw lines: in a stack only the bottom series has a level baseline.
- On a line, `color` draws a separate line for each value of its field. To mark some points on one line, such as failed runs, use `layer`: the line first, then a `point` mark with a `transform` that filters to those rows.
- Color follows the series order and Pimi sets the palette, so do not set colors. Keep the same series names in every chart of a reply, and refer to a series by name, never by color.
- To mark a threshold or target, use `layer`: the data mark first, then a `rule` with `"datum"` at the value.
- Use one plot per block. `facet`, `concat`, and `repeat` draw wider than a phone and scroll sideways; use them only for up to three small panels.
- Follow the chart with one sentence that says what it means or what to do. Do not list the values again in prose or in a table; pointing at a mark shows them. Add a table only for columns the chart does not show.

## Views

- Order a view as the reader's questions arrive: the verdict, the evidence, the detail.
- A metric `value` is a figure with its unit, such as "4m 12s". Put what `delta` compares against in `hint`, such as "vs last week". Add `trend` when you have the recent values.
- Set `tone` by whether the change is good, not by its sign: latency down 12% is positive. Tone only the one or two items that need attention and leave the rest neutral. Say the same thing in words ("Failing", "+12%"), since tone is only a color.
- Use a `text` node for a one-line verdict or caveat. Longer explanation goes in the reply.
- Align numeric table columns with `"align":"end"`.
- A phone shows four table columns and scrolls sideways for the rest. Put the name first and the columns that answer the question next.

## Diagrams

- Draw only the parts the question is about. Name boxes as the code does, so the user can search for them.
- Keep a flow box `label` to the name. Put what the box does, or why it matters, in `detail`; the reader sees it on hover or press.
- Set `kind` on each flow box to what it is: `user`, `agent`, `service`, `data`, `file`, `queue`, `tool`, `code`, `external`, or `secret`. It picks the box's icon and colour, so the reader tells a database from a service at a glance. Leave it out, or use `step`, for a stage or state that is none of these. `tone` overrides the colour, so keep it for the box that failed, warns, or succeeded.
- Declare lanes in the order the flow passes through them. When every edge moves forward through the lanes, each lane is a band across the flow and a pipeline reads straight down. A flow that goes back and forth between lanes, such as client and server, draws its lanes as swimlanes.
- A phone fits three boxes side by side, and a wider flow scrolls sideways. When more than three boxes feed or follow the same box, keep the two that matter and merge the rest into one box that lists them in its `detail`.
- Label an edge with a verb of one or two words for what it does: "calls", "writes", "reads from", "retries". The label sits on the edge as a chip, and each one widens the gap it crosses, so leave it off when the two boxes already say it. An edge back to an earlier box draws dotted, so you can show a retry or a loop.
- Leave `direction` out unless the flow reads better one way. A flow too wide for the column turns down by itself.
- In a sequence, write a message as what is sent ("POST /login", "401 retry"), not what the sender is doing. Use a `note` for a fact about the exchange that is not a message.
- In Mermaid, use plain text labels. Only `<br>` and `<i>` tags render; other tags, `&#` entities, and `@{...}` shapes make the diagram show as source.

## Before you send

- Does the title state the finding?
- Recompute one figure from the source. Does it match the visual, and do the parts add up to the stated total?
- Are the unit and the time range or sample size visible?
- Would an earlier row of the table answer the question? Use it.
- In `pimi-vega`: does every `field` name a column that exists in `data.values`, spelled the same, and does every field have a `type`? A wrong field name draws an empty chart.
- In `pimi-view`: one cell per column in every row, distinct flow box ids with every edge naming two of them, every sequence `from` and `to` naming a participant id, and no Markdown in text fields.

## Writing a pimi-html block

### Inline or file

- Write the HTML inline in a `pimi-html` block. This is the default: nothing is written to the project, and the visual runs in the reply.
- Write a project file and show it with a `pimi-artifact` block only when the user asked for a file to keep. When the HTML is larger than the `pimi-html` limit, aggregate or sample the data and say so in the title instead.

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

For a file, save one `.html` file of 1 MB at most and point at it with its path relative to the working directory, using forward slashes:

```pimi-artifact
{"title":"Latency explorer","path":"latency-explorer.html"}
```

### Rules for both

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

## Block formats

<!-- formats:start (generated by packages/protocol/scripts/generate-visualize-formats.mjs; do not edit) -->

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
- Data larger than the limit: aggregate or sample it into the block and say so in the title. Never save HTML to the project to get around the limit. Only when the user asks for a file to keep, save one .html file in the project and show it with a pimi-artifact block holding {"title":"...","path":"its-path-relative-to-the-working-directory.html"}.

<!-- formats:end -->
