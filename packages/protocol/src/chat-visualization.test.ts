import { expect, it } from "vitest";
import { PIMI_VISUALIZATION_INSTRUCTIONS } from "./chat-visualization.js";
import {
  PIMI_CHART_FENCE,
  PIMI_VIEW_FENCE,
  VIEW_LIMITS,
  VIEW_NODE_FIELDS,
  parseChatView,
  viewFenceOf,
} from "./chat-view.js";

function examples(): { language: string; source: string }[] {
  return [...PIMI_VISUALIZATION_INSTRUCTIONS.matchAll(/^```(\S+)\n([\s\S]*?)\n```$/gm)].map(
    ([, language, source]) => ({ language, source }),
  );
}

it("teaches one valid example of each block", () => {
  const blocks = examples();
  expect(blocks.map(({ language }) => language)).toEqual([PIMI_CHART_FENCE, PIMI_VIEW_FENCE]);
  for (const { language, source } of blocks) {
    const fence = viewFenceOf(language);
    expect(fence).not.toBeNull();
    expect(parseChatView(fence!, source), source).not.toBeNull();
  }
});

it("names every node type and its limits", () => {
  for (const [type, fields] of Object.entries(VIEW_NODE_FIELDS)) {
    expect(PIMI_VISUALIZATION_INSTRUCTIONS).toContain(`- ${type}: ${fields}`);
  }
  for (const limit of ["nodes", "depth", "children", "series", "tableRows"] as const) {
    expect(PIMI_VISUALIZATION_INSTRUCTIONS).toContain(String(VIEW_LIMITS[limit]));
  }
});

it("keeps the standing rules", () => {
  expect(PIMI_VISUALIZATION_INSTRUCTIONS).toContain("Put only JSON inside the block.");
  expect(PIMI_VISUALIZATION_INSTRUCTIONS).toContain(
    "Use real values or label the chart as an example.",
  );
  expect(PIMI_VISUALIZATION_INSTRUCTIONS).toContain("another complete block with the same id");
  expect(PIMI_VISUALIZATION_INSTRUCTIONS).toContain("pimi-artifacts skill");
  expect(PIMI_VISUALIZATION_INSTRUCTIONS).toContain("Mermaid only for flows");
});
