---
name: pimi-visualize
description: Choose and design a chart, dashboard, diagram, or table in Pimi chat. Use when the user asks to visualize, chart, graph, plot, diagram, compare, or "show me" a trend, breakdown, distribution, dashboard, system, or flow, wants something made easier to see, or when a reply is about to contain a table of numbers.
---

The system prompt lists the block fields and limits. This skill decides which form to use and what goes in it.

## Before you draw

Answer these silently. Do not print them.

1. **Question.** What is the user trying to find out, and what will they do next? "Is the build healthy" needs a verdict first. "Why is it slow" needs the biggest contributor first.
2. **Takeaway.** Write the one sentence the visual must show. That sentence becomes the title. If you cannot write it, read more data before drawing.
3. **Data.** Get values where they are produced: run the command, read the log, parse the file, count the rows. Do not chart numbers from memory, from an earlier summary in the chat, or estimated by eye. If you cannot get real values, put "sample" in the title.
4. **Reader.** The chat column is narrow and may be a phone. Put one idea in one block. A second idea is a second block or a sentence.
5. **Proof.** Choose one figure the user can check against the source, such as a total, a row count, or the latest value, and make sure the visual shows it.

## Pick the form

Use the first row that answers the question. Go to a later row only when an earlier one cannot.

| The user wants                                                        | Use                                                               | What makes it work                                                                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One or two numbers ("what's the p95")                                 | A sentence                                                        | No block. Give the number, its unit, the time range or sample size, and what it compares to.                                                                      |
| A few values compared                                                 | `pimi-chart` bar                                                  | One series, sorted by value.                                                                                                                                      |
| A ranking ("which have the most")                                     | `pimi-chart` bar; `pimi-view` table when names are long           | Sort descending. Keep the top 8 and add the rest as one "Other (n)" bar. Past 12 items, or when exact values matter, use the table.                               |
| Change over time                                                      | `pimi-chart` line; bar for fewer than six periods                 | Labels oldest first at even intervals. Say the direction and size of the change in the title.                                                                     |
| Parts of a whole                                                      | `pimi-chart` donut                                                | Up to five slices that add up to the whole, largest first, "Other" last. To compare shares between groups, use a stacked bar.                                     |
| A distribution                                                        | `pimi-chart` bar of bins                                          | Bin the raw values into 5 to 12 equal ranges. Label each bar with its range and keep range order. Name the median or p95 in the title.                            |
| A relationship between two measures                                   | `pimi-chart` scatter                                              | One point per item. Set `xLabel` and `yLabel` with units. Say in the sentence whether they move together.                                                         |
| Before and after, or A against B                                      | `pimi-chart` bar with two series                                  | Same labels for both, baseline series first, the difference in the title. For one or two measures, use a sentence.                                                |
| Several metrics at once (build or test health, cost, usage)           | `pimi-view`                                                       | Two to four metrics that answer the question, then one chart, then a detail table. Leave out a level that adds nothing.                                           |
| Records to scan or sort                                               | `pimi-view` table; Markdown table when cells need links or code   | Write numbers as numbers and put the unit in the column label, so sorting works. Order rows by the column that answers the question.                              |
| A process, architecture, sequence, state machine, or dependency graph | Mermaid                                                           | `flowchart`, `sequenceDiagram`, or `stateDiagram-v2`. Up to 12 nodes per diagram; split a larger system into an overview and one detail diagram. Label the edges. |
| A timeline or plan                                                    | Mermaid `gantt` for dated work; a numbered list for ordered steps | Give every dated item a start and a length. Steps without dates read better as a list.                                                                            |
| To explore: what-if sliders, filters, toggles                         | `pimi-artifact`                                                   | Use it only when the user would change an input. Follow the **pimi-artifacts** skill for the file rules.                                                          |
| A map, or a layout no block can express                               | `pimi-artifact`                                                   | Draw it as inline SVG. Follow the **pimi-artifacts** skill.                                                                                                       |

Two approaches compared on qualities, not numbers, go in a Markdown table with one row per criterion and a sentence that names the pick.

## Charts

- Write the title as the finding, with its number and time range: "Test time rose 38% after run 412", not "Test time by run". A reader who sees only the title should get the answer.
- Set `unit`. Put the time range or sample size in the title or `xLabel`.
- Sort bars by value. Keep the given order only when labels have their own order, such as dates, versions, or size ranges.
- Bar, line, and area axes always include zero. When the change is small next to the level (480 ms to 495 ms), chart the difference or percent change from the first value and say so in the title.
- The axis shows only the labels that fit, about six at 12 characters each. Shorten labels, for example by dropping a shared prefix, or use a table.
- Past seven series or slices, keep the largest and sum the rest as "Other". When lines cross into a tangle, put one line chart per series in a `pimi-view` grid with the same labels.
- Stack bars or areas only when the parts add up to a total the user cares about.
- Color follows series position and you cannot set it. Keep series in the same order with the same names in every chart of a reply, and refer to a series by name, never by color.
- Use a pie or donut only for shares of one total. To compare sizes, use a bar.
- Follow the chart with one sentence that says what it means or what to do. Do not list the values again; hovering shows them.

## Views

- Order a view as the reader's questions arrive: the verdict, the evidence, the detail.
- A metric `value` is a figure with its unit, such as "4m 12s". Put what `delta` compares against in `hint`, such as "vs last week". Add `trend` when you have the recent values.
- Set `tone` by whether the change is good, not by its sign: latency down 12% is positive. Tone only the one or two items that need attention and leave the rest neutral. Say the same thing in words ("Failing", "+12%"), since tone is only a color.
- Use `progress` for a value against a limit or target: budget spent, coverage against a goal, quota used.
- Use a `text` node for a one-line verdict or caveat. Longer explanation goes in the reply.
- Align numeric table columns with `"align":"end"`.

## Diagrams

- Draw only the parts the question is about. Name nodes as the code does, so the user can search for them.
- Use plain text labels. Only `<br>` and `<i>` tags render; other tags, `&#` entities, and `@{...}` shapes make the diagram show as source.

## HTML artifacts

- One idea per artifact. Start every control at the real current value, so the first render already answers the question.
- Check that it reads at 360 px wide with no sideways scroll.
- Write "sample data" on the page when the values are not real.

## Before you send

- Does the title state the finding?
- Recompute one figure from the source. Does it match the visual, and do the parts add up to the stated total?
- Are the unit and the time range or sample size visible?
- Would an earlier row of the table answer the question? Use it.
- Does the JSON hold: one value per label, distinct labels and series names, one cell per column in every row, no Markdown in text fields, no fields the system prompt does not list?
