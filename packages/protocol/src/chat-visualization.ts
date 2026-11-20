import { PIMI_ARTIFACT_FENCE } from "./chat-artifact.js";
import { PIMI_HTML_FENCE, PIMI_HTML_VARIABLES } from "./chat-html.js";
import { PIMI_VEGA_FENCE } from "./chat-vega.js";
import { PIMI_VIEW_FENCE, VIEW_NODE_FIELDS, VIEW_TONES } from "./chat-view.js";

/** Agents are not taught the chart node: a chart is a pimi-vega block. Stored chats still draw it. */
const TAUGHT_NODE_FIELDS = Object.entries(VIEW_NODE_FIELDS).filter(([type]) => type !== "chart");

/** The core Pimi tool that returns the block formats to a provider that cannot read skills. */
export const PIMI_VISUALIZATION_GUIDE_TOOL = "get_pimi_visualization_guide";

function brief(formats: string): string {
  return `Pimi chat renders ${PIMI_VEGA_FENCE}, ${PIMI_VIEW_FENCE}, ${PIMI_HTML_FENCE} and mermaid fenced blocks inline in a reply. To show a chart, diagram, or interactive visual, write one in the reply, not a project file unless the user asks for a file; ${formats} for the formats first.`;
}

/** For providers that read the bundled pimi-visualize skill, whose SKILL.md holds the formats. */
export const PIMI_VISUALIZATION_BRIEF = brief("load the pimi-visualize skill");

/** For providers that cannot read skills but have Pimi's tools. */
export const PIMI_VISUALIZATION_TOOL_BRIEF = brief(`call ${PIMI_VISUALIZATION_GUIDE_TOOL}`);

/**
 * What each block accepts and what its renderer does, and nothing about which visual to draw or
 * how it should look: that is the agent's call. Written from the parsers' own constants. The guide
 * tool returns it, the pimi-visualize skill ships it, and a provider with neither gets it inline.
 */
export const PIMI_VISUALIZATION_INSTRUCTIONS = [
  "Pimi chat renders these fenced code blocks inline in a reply. Use whichever shows the answer best.",
  "",
  `${PIMI_VEGA_FENCE}: one Vega-Lite v6 spec as JSON.`,
  '- Rows go inline in data.values. Nothing can load: a "url" or "href" property anywhere in the spec fails the block, and so does a raw Vega spec.',
  "- Pimi fits the width, applies its light or dark theme, shows tooltips, and shows the spec's title above the chart.",
  "",
  `${PIMI_VIEW_FENCE}: JSON {"title", "root", optional "id"} where root is a node. Each node is an object with a "type" and these fields:`,
  ...TAUGHT_NODE_FIELDS.map(([type, fields]) => `- ${type}: ${fields}`),
  `A tone is one of ${VIEW_TONES.join(", ")}. Every text field is plain text: no Markdown, HTML, links, images, or colors. Pimi lays out flows and sequences itself.`,
  "A later block with the same id replaces the earlier one in the same reply.",
  "",
  `${PIMI_HTML_FENCE}: one HTML document or fragment, run in a sandboxed frame.`,
  "- No network, storage, or navigation: remote scripts, styles, fonts, images, and fetch fail. Put the CSS, JavaScript, and data in the block.",
  `- Pimi sets the page background, text color, and font for its light and dark themes and provides these custom properties: ${PIMI_HTML_VARIABLES.map((name) => `--pimi-${name}`).join(", ")}.`,
  "- The frame is the reply's width, about 360 px on a phone. It follows the content's height up to 640 px, then scrolls, so 100vh has no meaning.",
  "- The <title> is shown above the frame. Three backticks inside the block end it.",
  `- ${PIMI_ARTIFACT_FENCE} holds {"title", "path"} and runs a saved .html file the same way, with the path relative to the working directory.`,
  "",
  "mermaid: a Mermaid diagram, scaled down to fit the reply's width.",
].join("\n");
