import { PIMI_ARTIFACT_FENCE } from "./chat-artifact.js";
import { HTML_LIMITS, PIMI_HTML_FENCE, PIMI_HTML_VARIABLES } from "./chat-html.js";
import { PIMI_VEGA_FENCE, VEGA_LIMITS } from "./chat-vega.js";
import {
  PIMI_VIEW_FENCE,
  VIEW_LIMITS,
  VIEW_NODE_FIELDS,
  VIEW_TONES,
  type ChatView,
} from "./chat-view.js";

/**
 * The examples are objects, not strings, so the view examples are checked against the catalog's
 * types at build time. The chart example has no type here: the Vega-Lite types live in the app.
 */
export const VEGA_EXAMPLE = {
  title: "Pro revenue passed Free in March 2026",
  data: {
    values: [
      { month: "Jan", plan: "Free", usd: 410 },
      { month: "Jan", plan: "Pro", usd: 280 },
      { month: "Feb", plan: "Free", usd: 430 },
      { month: "Feb", plan: "Pro", usd: 390 },
      { month: "Mar", plan: "Free", usd: 440 },
      { month: "Mar", plan: "Pro", usd: 520 },
    ],
  },
  mark: "line",
  encoding: {
    x: { field: "month", type: "ordinal", sort: null, title: null },
    y: { field: "usd", type: "quantitative", title: "Revenue (USD)" },
    color: { field: "plan", type: "nominal", title: null },
  },
};

export const VIEW_EXAMPLE = {
  id: "build",
  title: "Build is healthy; two slow suites",
  root: {
    type: "stack",
    children: [
      {
        type: "grid",
        columns: 2,
        children: [
          {
            type: "metric",
            label: "Pass rate",
            value: "98%",
            delta: "+2%",
            tone: "positive",
            hint: "vs last week",
            trend: [91, 94, 96, 98],
          },
          { type: "metric", label: "Median time", value: "4m 12s" },
        ],
      },
      { type: "progress", label: "Coverage against the 80% goal", value: 71, max: 80 },
      {
        type: "table",
        columns: [{ label: "Suite" }, { label: "Time (s)", align: "end" }],
        rows: [
          ["e2e", 148],
          ["integration", 96],
        ],
      },
    ],
  },
} satisfies ChatView;

export const FLOW_EXAMPLE = {
  id: "request-path",
  title: "A request passes auth before the handler",
  root: {
    type: "flow",
    lanes: [
      { id: "edge", label: "Edge" },
      { id: "app", label: "App" },
    ],
    nodes: [
      { id: "router", label: "router.ts", lane: "edge" },
      {
        id: "auth",
        label: "checkAuth",
        lane: "edge",
        detail: "Rejects expired tokens with 401",
      },
      { id: "handler", label: "handleRequest", lane: "app" },
      { id: "login", label: "Login page", lane: "edge", tone: "warning" },
    ],
    edges: [
      { from: "router", to: "auth" },
      { from: "auth", to: "handler", label: "valid" },
      { from: "auth", to: "login", label: "expired" },
    ],
  },
} satisfies ChatView;

export const HTML_EXAMPLE = [
  "<title>Tip calculator</title>",
  "<style>input{background:var(--pimi-surface);color:var(--pimi-fg);border:1px solid var(--pimi-border);border-radius:6px;padding:4px 8px}</style>",
  '<label>Bill <input id="bill" type="number" value="40"></label>',
  '<p id="tip"></p>',
  "<script>",
  'const bill = document.getElementById("bill"), tip = document.getElementById("tip");',
  'const draw = () => { tip.textContent = "20% tip: $" + (bill.value * 0.2).toFixed(2); };',
  'bill.addEventListener("input", draw); draw();',
  "</script>",
].join("\n");

function fenced(fence: string, body: string): string[] {
  return [`\`\`\`${fence}`, body, "```"];
}

/** Agents are not taught the chart node: a chart is a pimi-vega block. Stored chats still draw it. */
const TAUGHT_NODE_FIELDS = Object.entries(VIEW_NODE_FIELDS).filter(([type]) => type !== "chart");

/** Written from the parsers' own constants, so the prompt and the parsers cannot disagree. */
export const PIMI_VISUALIZATION_INSTRUCTIONS = [
  "Pimi chat draws four kinds of visual block. When a reply holds three or more numbers that compare, trend, break down into shares, or relate to each other, draw them, even when the user did not ask for a chart. The chart stands in for a table of the same values: add a table beside it only for columns the chart does not show. Chart the numbers that answer the question, and do not count files or lines only to have something to chart. Choose the block by what is shown, and use the first that fits:",
  `1. A chart of numbers (trend, comparison, ranking, distribution, share, or relationship): a ${PIMI_VEGA_FENCE} block.`,
  `2. Headline metrics, a table of records, progress against a limit, or a flow, pipeline, architecture, call path, or dependency graph: a ${PIMI_VIEW_FENCE} block.`,
  `3. Something the user operates, such as a calculator, simulator, or explorer with sliders, inputs, or toggles: a ${PIMI_HTML_FENCE} block.`,
  "4. A sequence diagram, state machine, or gantt chart: a mermaid block. Use Mermaid for nothing else: no flowchart, graph, pie, or xychart. Pimi shrinks the diagram to fit the chat column and a box 480 px tall, so a large one cannot be read. Keep it to 5 participants or 8 states and 15 arrows, counting each note as an arrow, and split a longer one into two diagrams.",
  "Write the block straight into the reply as a fenced code block with that name, holding only what the block takes: no comments, and no code fence inside it. Say one or two numbers in a sentence instead of drawing them.",
  "In any table, Markdown or block, the first column is the name and the second is the figure the user asked about: a phone shows four columns and hides the rest behind a sideways scroll.",
  'Take every figure in a block from the output of a command, not from arithmetic in your head, or put "sample" in the title. Make the title state the finding, with its unit and time range. For a dashboard, or when two forms could fit, read the pimi-visualize skill first.',
  "",
  `${PIMI_VEGA_FENCE} holds one Vega-Lite v6 spec as JSON:`,
  ...fenced(PIMI_VEGA_FENCE, JSON.stringify(VEGA_EXAMPLE)),
  `- Put the rows inline in data.values, one object per row: up to ${VEGA_LIMITS.rows} rows and ${VEGA_LIMITS.sourceLength} characters for the block. Aggregate or sample larger data first.`,
  '- Give raw rows and let the spec do the math with "aggregate", "bin", "stack", or "transform". For a distribution, use mark "bar" with x {"bin": true} and y {"aggregate": "count"}.',
  '- To compare several measures per item, write one row per item and measure, then use "color" with "xOffset" for grouped bars.',
  '- On a line, "color" draws a separate line for each value of its field. To mark some points on one line, such as the failed runs, use "layer": the line, then a "point" mark with a "transform" that filters to those rows.',
  '- A ranking holds up to 12 bars. Keep the largest and sum the rest into one "Other" row.',
  '- Set "type" on every field. Add "sort": null to keep the row order, such as months.',
  '- Leave out "$schema", "width", "config", colors, and fonts. Pimi fits the width and applies its theme, and tooltips are already on.',
  '- The chart cannot load anything. A "url" or "href" property anywhere in the spec makes the block fail.',
  "",
  `${PIMI_VIEW_FENCE} holds JSON with a title and one root node. Nodes nest, for example metrics above a table:`,
  ...fenced(PIMI_VIEW_FENCE, JSON.stringify(VIEW_EXAMPLE)),
  "A flow node lays its boxes out for you. Give each box a short id and the name the code uses as its label, put the explanation in detail, and group boxes into lanes by layer or owner. A phone fits three boxes side by side: when more than three boxes feed or follow the same box, keep the two that matter and merge the rest into one box that lists them in its detail:",
  ...fenced(PIMI_VIEW_FENCE, JSON.stringify(FLOW_EXAMPLE)),
  'Each node is an object with a "type" and these fields:',
  ...TAUGHT_NODE_FIELDS.map(([type, fields]) => `- ${type}: ${fields}`),
  `A tone is one of ${VIEW_TONES.join(", ")}. Every text field is plain text: no Markdown, HTML, links, images, or colors.`,
  `Limits: ${VIEW_LIMITS.nodes} nodes, ${VIEW_LIMITS.depth} levels, ${VIEW_LIMITS.children} children per node, ${VIEW_LIMITS.tableColumns} table columns, ${VIEW_LIMITS.tableRows} table rows, ${VIEW_LIMITS.trendPoints} trend points, ${VIEW_LIMITS.title} characters per title, ${VIEW_LIMITS.label} per label, ${VIEW_LIMITS.value} per metric value, ${VIEW_LIMITS.cell} per table cell, ${VIEW_LIMITS.text} per text, ${VIEW_LIMITS.sourceLength} for the block. A flow holds up to ${VIEW_LIMITS.flowNodes} boxes, ${VIEW_LIMITS.flowEdges} edges, and ${VIEW_LIMITS.flowLanes} lanes, with ${VIEW_LIMITS.flowLabel} characters per box label, ${VIEW_LIMITS.flowEdgeLabel} per edge label, and ${VIEW_LIMITS.flowDetail} per detail. Every edge must name two different boxes by id.`,
  `To update a ${PIMI_VIEW_FENCE} block within the same reply, send another complete block with the same id.`,
  "",
  `${PIMI_HTML_FENCE} holds one HTML document or fragment, up to ${HTML_LIMITS.sourceLength} characters. Pimi runs it inline and shows its <title> above it:`,
  ...fenced(PIMI_HTML_FENCE, HTML_EXAMPLE),
  "- It runs in a sandbox with no network, storage, or navigation. Remote scripts, styles, fonts, images, and fetch all fail, so write the CSS, JavaScript, and data inline.",
  `- Pimi sets the page background, text color, and font. Style everything else with these custom properties so it follows light and dark themes, and never hardcode a page or text color: ${PIMI_HTML_VARIABLES.map((name) => `--pimi-${name}`).join(", ")}.`,
  "- Start every control at a realistic value, so the first render already shows an answer. Lay it out to fit 360 px wide, and let the page take its natural height: no 100vh.",
  `- For a visual larger than the limit, or one the user wants kept as a file, use the pimi-artifacts skill: save the HTML in the workspace and show it with a ${PIMI_ARTIFACT_FENCE} block.`,
].join("\n");
