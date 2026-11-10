import { PIMI_ARTIFACT_FENCE } from "./chat-artifact.js";
import {
  CHART_POINT_LIMITS,
  PIMI_CHART_FENCE,
  PIMI_VIEW_FENCE,
  VIEW_LIMITS,
  VIEW_NODE_FIELDS,
  VIEW_TONES,
} from "./chat-view.js";

const CHART_EXAMPLE =
  '{"type":"bar","id":"jobs","title":"Jobs by day","unit":"jobs","labels":["Mon","Tue","Wed"],"series":[{"name":"Passed","values":[4,7,5]},{"name":"Failed","values":[1,0,2]}],"stacked":true}';

const VIEW_EXAMPLE =
  '{"id":"build","title":"Build health","root":{"type":"stack","children":[{"type":"grid","columns":2,"children":[{"type":"metric","label":"Pass rate","value":"98%","delta":"+2%","tone":"positive","trend":[91,94,96,98]},{"type":"metric","label":"Median time","value":"4m 12s"}]},{"type":"chart","kind":"line","title":"Failures by day","labels":["Mon","Tue","Wed"],"series":[{"name":"Failures","values":[3,1,2]}]}]}}';

function fenced(fence: string, json: string): string[] {
  return [`\`\`\`${fence}`, json, "```"];
}

/** Written from the catalog's own constants, so the prompt and the parser cannot disagree. */
export const PIMI_VISUALIZATION_INSTRUCTIONS = [
  `When numbers compare, trend, or break down, show them in a ${PIMI_CHART_FENCE} or ${PIMI_VIEW_FENCE} block, not a Markdown table of numbers and not a Mermaid xychart or pie. Say one or two numbers in a sentence instead. Use Mermaid only for flows, sequences, and structure.`,
  `Pick the form by the question: bar to compare or rank (sorted by value), line for change over time, donut for up to five parts of a whole, scatter for a relationship, ${PIMI_VIEW_FENCE} for several metrics or a sortable table. For a dashboard, a diagram, or a choice between forms, read the pimi-visualize skill first.`,
  "Put only JSON inside the block. Use real values or label the chart as an example. Make the title state the finding, and give the unit and time range.",
  `${PIMI_CHART_FENCE} is one chart. Its type is the chart kind: ${Object.keys(CHART_POINT_LIMITS).join(", ")}.`,
  ...fenced(PIMI_CHART_FENCE, CHART_EXAMPLE),
  `Give each series one number per label. Use up to ${VIEW_LIMITS.series} distinctly named series and distinct labels: up to ${CHART_POINT_LIMITS.bar} for bar, pie and donut, ${CHART_POINT_LIMITS.line} for line and area. For pie and donut, use one series with nonnegative values and a positive total. For scatter, omit labels and give each series points as [x, y] pairs: up to ${CHART_POINT_LIMITS.scatter} per series, ${VIEW_LIMITS.scatterPoints} in total.`,
  `${PIMI_VIEW_FENCE} combines nodes under one root, for example headline metrics above a chart or a table.`,
  ...fenced(PIMI_VIEW_FENCE, VIEW_EXAMPLE),
  'Each node is an object with a "type" and these fields:',
  ...Object.entries(VIEW_NODE_FIELDS).map(([type, fields]) => `- ${type}: ${fields}`),
  `A tone is one of ${VIEW_TONES.join(", ")}. Every text field is plain text. There are no fields for Markdown, HTML, links, images, or colors, and an unknown field makes the block invalid.`,
  `Limits: ${VIEW_LIMITS.nodes} nodes, ${VIEW_LIMITS.depth} levels, ${VIEW_LIMITS.children} children per node, ${VIEW_LIMITS.tableColumns} table columns, ${VIEW_LIMITS.tableRows} table rows, ${VIEW_LIMITS.trendPoints} trend points, ${VIEW_LIMITS.title} characters per title, ${VIEW_LIMITS.label} per label, ${VIEW_LIMITS.cell} per table cell, ${VIEW_LIMITS.text} per text, ${VIEW_LIMITS.sourceLength} for the block.`,
  "To update a chart or view within the same reply, send another complete block with the same id. In a new reply, send a new complete block.",
  `For a custom visual that needs its own controls or layout, use the pimi-artifacts skill. Save self-contained HTML in the workspace and show it with a ${PIMI_ARTIFACT_FENCE} JSON block containing title and workspace-relative path. It runs inline in the chat.`,
].join("\n");
