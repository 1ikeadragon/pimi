---
name: pimi-visualize
description: Choose and design a chart, dashboard, diagram, table, or interactive visual in Pimi chat. Use when the user asks to visualize, chart, graph, plot, diagram, compare, or "show me" a trend, breakdown, distribution, dashboard, system, or flow, wants something made easier to see, or when a reply is about to contain a table of numbers.
---

The system prompt gives each block's format, one example, and its limits. This skill decides which block to use and what goes in it.

## Before you draw

Answer these silently. Do not print them.

1. **Question.** What is the user trying to find out, and what will they do next? "Is the build healthy" needs a verdict first. "Why is it slow" needs the biggest contributor first.
2. **Takeaway.** Write the one sentence the visual must show. That sentence becomes the title. If you cannot write it, read more data before drawing.
3. **Data.** Get values where they are produced: run the command, read the log, parse the file, count the rows. Do not chart numbers from memory, from an earlier summary in the chat, or estimated by eye. If you cannot get real values, put "sample" in the title.
4. **Reader.** The chat column is narrow and may be a phone. Put one idea in one block. A second idea is a second block or a sentence.
5. **Proof.** Choose one figure the user can check against the source, such as a total, a row count, or the latest value, and make sure the visual shows it.

## Pick the block

Use the first row that answers the question. Go to a later row only when an earlier one cannot.

| The user wants                                                     | Block                                                             | How                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One or two numbers ("what's the p95")                              | A sentence                                                        | No block. Give the number, its unit, the time range or sample size, and what it compares to.                                                                                                                           |
| A few values compared, or a ranking                                | `pimi-vega`, mark `bar`                                           | Category on `y` with `"sort": "-x"`, value on `x`, so long names stay readable. Keep the top 8 and sum the rest into one "Other" row. Past 12 items, or when exact values matter, use a `pimi-view` table.             |
| Change over time                                                   | `pimi-vega`, mark `line`                                          | Time on `x` as `temporal` (ISO dates) or `ordinal` with `"sort": null`. Use mark `bar` for fewer than six periods.                                                                                                     |
| Several series over time                                           | `pimi-vega`, mark `line` with `color`                             | One row per date and series. Up to seven series; past that, keep the largest and sum the rest as "Other".                                                                                                              |
| Several measures for a few items (3 frameworks, 4 metrics)         | `pimi-vega`, mark `bar` with `color` and `xOffset`                | One row per item and measure. Put the measure on `x`, the item on `color` and `xOffset`. When the measures have different units, use a `pimi-view` table instead: one shared axis would mislead.                       |
| Parts of a whole                                                   | `pimi-vega`, mark `arc`                                           | `theta` for the value, `color` for the part, `"innerRadius": 60` for a donut. Up to five parts. To compare shares between groups, use a stacked bar with `"stack": "normalize"`.                                       |
| A distribution                                                     | `pimi-vega`, mark `bar` with `"bin": true`                        | Give the raw values, one row each; `x` is the binned field and `y` is `{"aggregate": "count"}`. Name the median or p95 in the title. Above the row limit, bin the data yourself and plot one bar per bin.              |
| A relationship between two measures                                | `pimi-vega`, mark `point`                                         | One row per item. Title both axes with units. Say in the sentence whether they move together.                                                                                                                          |
| Two dimensions at once (hour by weekday)                           | `pimi-vega`, mark `rect`                                          | Both dimensions `ordinal`, the value on `color` as `quantitative`.                                                                                                                                                     |
| Several headline figures (build health, cost, usage)               | `pimi-view` metrics                                               | Two to four metrics that answer the question, then a table of the detail. Put a chart of the same data in its own `pimi-vega` block after it.                                                                          |
| Records to scan or sort                                            | `pimi-view` table; Markdown table when cells need links or code   | Write numbers as numbers and put the unit in the column label, so sorting works. Order rows by the column that answers the question.                                                                                   |
| A value against a limit (budget, quota, coverage goal)             | `pimi-view` progress                                              | `value` and `max` in the same unit, with the unit in the label.                                                                                                                                                        |
| A process, pipeline, architecture, call path, or dependency graph  | `pimi-view` flow                                                  | Name boxes as the code does and put what each one does in `detail`. Group boxes into lanes by layer or owner. Label the edges that branch. Up to 24 boxes; split a larger system into an overview and one detail flow. |
| A sequence of messages or a state machine                          | Mermaid `sequenceDiagram` or `stateDiagram-v2`                    | Up to 5 participants or 8 states, and 15 arrows with each note counted as one: the diagram is shrunk to fit the column and a 480 px box. Split a longer one in two. Label every message or transition.                 |
| A timeline or plan                                                 | Mermaid `gantt` for dated work; a numbered list for ordered steps | Give every dated item a start and a length. Steps without dates read better as a list.                                                                                                                                 |
| To try inputs: a calculator, what-if sliders, filters, a simulator | `pimi-html`                                                       | Use it only when the user would change an input. Follow the **pimi-artifacts** skill.                                                                                                                                  |
| A map, or a layout no other block can express                      | `pimi-html`                                                       | Draw it as inline SVG. Follow the **pimi-artifacts** skill.                                                                                                                                                            |

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
- Declare lanes in the order the flow passes through them. When every edge moves forward through the lanes, each lane is a band across the flow and a pipeline reads straight down. A flow that goes back and forth between lanes, such as client and server, draws its lanes as swimlanes.
- A phone fits three boxes side by side, and a wider flow scrolls sideways. When more than three boxes feed or follow the same box, keep the two that matter and merge the rest into one box that lists them in its `detail`.
- Label only edges that branch or carry a condition, in a word or two. An edge back to an earlier box draws dashed, so you can show a retry or a loop.
- Leave `direction` out unless the flow reads better one way. A flow too wide for the column turns down by itself.
- In Mermaid, use plain text labels. Only `<br>` and `<i>` tags render; other tags, `&#` entities, and `@{...}` shapes make the diagram show as source.

## Before you send

- Does the title state the finding?
- Recompute one figure from the source. Does it match the visual, and do the parts add up to the stated total?
- Are the unit and the time range or sample size visible?
- Would an earlier row of the table answer the question? Use it.
- In `pimi-vega`: does every `field` name a column that exists in `data.values`, spelled the same, and does every field have a `type`? A wrong field name draws an empty chart.
- In `pimi-view`: one cell per column in every row, distinct flow box ids with every edge naming two of them, and no Markdown in text fields.
