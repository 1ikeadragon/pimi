import { describe, expect, it } from "vitest";
import {
  PIMI_CHART_FENCE,
  PIMI_VIEW_FENCE,
  VIEW_LIMITS,
  VIEW_NODE_FIELDS,
  parseChatView,
  viewFenceOf,
  type ViewNodeType,
} from "./chat-view.js";

function chart(document: unknown) {
  return parseChatView(PIMI_CHART_FENCE, JSON.stringify(document));
}

function view(root: unknown, rest: Record<string, unknown> = {}) {
  return parseChatView(PIMI_VIEW_FENCE, JSON.stringify({ ...rest, root }));
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function diagonal(length: number): [number, number][] {
  return range(length).map((value) => [value, value]);
}

function labels(length: number): string[] {
  return range(length).map((index) => `L${index}`);
}

const BAR = {
  type: "bar",
  title: "Jobs by day",
  labels: ["Mon", "Tue"],
  series: [{ name: "Jobs", values: [4, 7] }],
};

const NODE_SAMPLES: Record<ViewNodeType, Record<string, unknown>> = {
  stack: { type: "stack", direction: "row", children: [{ type: "text", content: "a" }] },
  grid: { type: "grid", columns: 3, children: [{ type: "text", content: "a" }] },
  section: { type: "section", title: "Totals", children: [{ type: "text", content: "a" }] },
  metric: {
    type: "metric",
    label: "Pass rate",
    value: "98%",
    delta: "+2%",
    tone: "positive",
    hint: "Last 7 days",
    trend: [1, 2, 3],
  },
  chart: { ...BAR, type: "chart", kind: "bar" },
  table: {
    type: "table",
    columns: [{ label: "Name" }, { label: "Count", align: "end" }],
    rows: [
      ["a", 1],
      ["b", 2],
    ],
  },
  progress: { type: "progress", label: "Done", value: 3, max: 10, tone: "warning" },
  text: { type: "text", content: "Plain", tone: "negative", emphasis: "strong" },
  badge: { type: "badge", label: "Beta", tone: "neutral" },
  flow: {
    type: "flow",
    direction: "down",
    lanes: [{ id: "cli", label: "CLI" }],
    nodes: [
      { id: "a", label: "parse", lane: "cli", detail: "Reads argv", tone: "warning" },
      { id: "b", label: "run" },
    ],
    edges: [{ from: "a", to: "b", label: "ok" }],
  },
};

describe("pimi-chart blocks written for the previous schema", () => {
  const stored = [
    '{"type":"bar","id":"jobs","title":"Jobs by day","labels":["Mon","Tue"],"series":[{"name":"Jobs","values":[4,7]}]}',
    '{"type":"line","title":"Latency","unit":"ms","labels":["a","b","c"],"series":[{"name":"p50","values":[1,2,3]},{"name":"p95","values":[4,5,6]},{"name":"p99","values":[7,8,9]},{"name":"max","values":[10,11,12]}]}',
    '{"type":"area","title":"  Padded  ","labels":["a"],"series":[{"name":"n","values":[-1.5]}]}',
    '{"type":"pie","title":"Share","labels":["x","y"],"series":[{"name":"s","values":[0,3]}]}',
    '{"type":"donut","title":"Share","unit":"USD","labels":["x","y"],"series":[{"name":"s","values":[1.7976931348623157e308,1.7976931348623157e308]}]}',
    JSON.stringify({
      type: "bar",
      title: "Full",
      labels: labels(36),
      series: [{ name: "a", values: range(36) }],
    }),
  ];

  it.each(stored)("still parses %s", (source) => {
    const old = JSON.parse(source);
    const parsed = parseChatView(PIMI_CHART_FENCE, source);
    expect(parsed).toEqual({
      ...(old.id === undefined ? {} : { id: old.id }),
      root: {
        type: "chart",
        kind: old.type,
        title: old.title.trim(),
        ...(old.unit === undefined ? {} : { unit: old.unit }),
        labels: old.labels,
        series: old.series,
      },
    });
  });

  it("keeps rejecting what the previous schema rejected", () => {
    expect(chart({ ...BAR, labels: ["Mon", "Mon"] })).toBeNull();
    expect(chart({ ...BAR, series: [{ name: "Jobs", values: [4] }] })).toBeNull();
    expect(
      chart({
        ...BAR,
        series: [
          { name: "Jobs", values: [4, 7] },
          { name: "Jobs", values: [1, 2] },
        ],
      }),
    ).toBeNull();
    expect(chart({ ...BAR, type: "pie", series: [{ name: "s", values: [-1, 2] }] })).toBeNull();
    expect(chart({ ...BAR, type: "pie", series: [{ name: "s", values: [0, 0] }] })).toBeNull();
    expect(chart({ ...BAR, title: "   " })).toBeNull();
  });
});

describe("pimi-chart", () => {
  it("accepts the chart node shape and the new fields", () => {
    expect(
      chart({
        ...BAR,
        type: "chart",
        kind: "bar",
        stacked: true,
        xLabel: "Day",
        yLabel: "Jobs",
      })?.root,
    ).toMatchObject({ type: "chart", kind: "bar", stacked: true, xLabel: "Day", yLabel: "Jobs" });
    expect(chart({ ...BAR, kind: "line" })).toBeNull();
  });

  it("validates scatter points", () => {
    const scatter = {
      type: "scatter",
      title: "Size against time",
      series: [
        {
          name: "Builds",
          points: [
            [1, 2],
            [3, 4],
          ],
        },
      ],
    };
    expect(chart(scatter)?.root).toMatchObject({ kind: "scatter", series: scatter.series });
    expect(chart({ ...scatter, labels: ["a", "b"] })?.root).not.toHaveProperty("labels");
    expect(chart({ ...scatter, series: [{ name: "Builds", points: [[1, 2, 3]] }] })).toBeNull();
    expect(chart({ ...scatter, series: [{ name: "Builds", points: [[1, "2"]] }] })).toBeNull();
    expect(chart({ ...scatter, series: [{ name: "Builds", points: [] }] })).toBeNull();
  });

  it("drops stacking and axis titles where they have no meaning", () => {
    expect(chart({ ...BAR, type: "line", stacked: true })?.root).not.toHaveProperty("stacked");
    expect(chart({ ...BAR, type: "pie", xLabel: "x" })?.root).not.toHaveProperty("xLabel");
  });

  it("only holds a chart", () => {
    expect(chart(NODE_SAMPLES.text)).toBeNull();
    expect(chart({ root: NODE_SAMPLES.chart })).toBeNull();
  });
});

describe("pimi-view", () => {
  it.each(Object.keys(VIEW_NODE_FIELDS) as ViewNodeType[])("accepts a %s node", (type) => {
    expect(view(NODE_SAMPLES[type])?.root).toEqual(NODE_SAMPLES[type]);
  });

  it("carries the id and title", () => {
    expect(view(NODE_SAMPLES.text, { id: "summary", title: "Summary" })).toEqual({
      id: "summary",
      title: "Summary",
      root: NODE_SAMPLES.text,
    });
  });

  it("requires a root node", () => {
    expect(parseChatView(PIMI_VIEW_FENCE, JSON.stringify(NODE_SAMPLES.text))).toBeNull();
    expect(parseChatView(PIMI_VIEW_FENCE, JSON.stringify(BAR))).toBeNull();
  });

  it("checks table and progress shapes", () => {
    expect(view({ ...NODE_SAMPLES.table, rows: [["a"]] })).toBeNull();
    expect(view({ ...NODE_SAMPLES.table, rows: [["a", true]] })).toBeNull();
    expect(view({ ...NODE_SAMPLES.progress, value: 11 })).toBeNull();
    expect(view({ ...NODE_SAMPLES.progress, max: 0 })).toBeNull();
    expect(view({ ...NODE_SAMPLES.grid, columns: 5 })).toBeNull();
    expect(view({ ...NODE_SAMPLES.grid, columns: 1.5 })).toBeNull();
    expect(view({ ...NODE_SAMPLES.metric, value: 98 })).toBeNull();
    expect(view({ ...NODE_SAMPLES.metric, tone: "red" })).toBeNull();
  });
});

describe("caps", () => {
  function nested(depth: number): unknown {
    let node: unknown = { type: "text", content: "leaf" };
    for (let level = 1; level < depth; level++) node = { type: "stack", children: [node] };
    return node;
  }
  const leaf = { type: "text", content: "x" };
  function wide(count: number) {
    return { type: "stack", children: range(count).map(() => leaf) };
  }

  it("limits source length", () => {
    const padding = (length: number) => JSON.stringify(BAR) + " ".repeat(length);
    const source = JSON.stringify(BAR);
    expect(
      parseChatView(PIMI_CHART_FENCE, padding(VIEW_LIMITS.sourceLength - source.length)),
    ).not.toBeNull();
    expect(
      parseChatView(PIMI_CHART_FENCE, padding(VIEW_LIMITS.sourceLength - source.length + 1)),
    ).toBeNull();
  });

  it("limits depth", () => {
    expect(view(nested(VIEW_LIMITS.depth))).not.toBeNull();
    expect(view(nested(VIEW_LIMITS.depth + 1))).toBeNull();
  });

  it("limits children per node", () => {
    expect(view(wide(VIEW_LIMITS.children))).not.toBeNull();
    expect(view(wide(VIEW_LIMITS.children + 1))).toBeNull();
  });

  it("limits the total node count", () => {
    // One root, four stacks, and their leaves.
    const tree = (leaves: number[]) => ({ type: "stack", children: leaves.map(wide) });
    expect(view(tree([11, 11, 11, 10]))).not.toBeNull();
    expect(view(tree([11, 11, 11, 11]))).toBeNull();
    expect(5 + 43).toBe(VIEW_LIMITS.nodes);
  });

  it("limits series", () => {
    const withSeries = (count: number) => ({
      ...BAR,
      series: range(count).map((index) => ({ name: `s${index}`, values: [1, 2] })),
    });
    expect(chart(withSeries(VIEW_LIMITS.series))).not.toBeNull();
    expect(chart(withSeries(VIEW_LIMITS.series + 1))).toBeNull();
  });

  it.each([
    ["bar", VIEW_LIMITS.categoryPoints],
    ["pie", VIEW_LIMITS.categoryPoints],
    ["donut", VIEW_LIMITS.categoryPoints],
    ["line", VIEW_LIMITS.continuousPoints],
    ["area", VIEW_LIMITS.continuousPoints],
  ])("limits %s points to %d", (type, limit) => {
    const withPoints = (count: number) => ({
      type,
      title: "t",
      labels: labels(count),
      series: [{ name: "s", values: range(count).map((index) => index + 1) }],
    });
    expect(chart(withPoints(limit))).not.toBeNull();
    expect(chart(withPoints(limit + 1))).toBeNull();
  });

  it("limits scatter points per series and in total", () => {
    const withPoints = (counts: number[]) => ({
      type: "scatter",
      title: "t",
      series: counts.map((count, index) => ({
        name: `s${index}`,
        points: diagonal(count),
      })),
    });
    expect(chart(withPoints([VIEW_LIMITS.continuousPoints]))).not.toBeNull();
    expect(chart(withPoints([VIEW_LIMITS.continuousPoints + 1]))).toBeNull();
    expect(chart(withPoints([120, 120, 120]))).not.toBeNull();
    expect(chart(withPoints([120, 120, 120, 1]))).toBeNull();
    expect(VIEW_LIMITS.scatterPoints).toBe(360);
  });

  it("limits string lengths", () => {
    expect(chart({ ...BAR, title: "t".repeat(VIEW_LIMITS.title) })).not.toBeNull();
    expect(chart({ ...BAR, title: "t".repeat(VIEW_LIMITS.title + 1) })).toBeNull();
    expect(chart({ ...BAR, unit: "u".repeat(VIEW_LIMITS.unit + 1) })).toBeNull();
    expect(chart({ ...BAR, labels: ["a", "b".repeat(VIEW_LIMITS.label + 1)] })).toBeNull();
    expect(chart({ ...BAR, id: "i".repeat(VIEW_LIMITS.label + 1) })).toBeNull();
    expect(view({ type: "text", content: "c".repeat(VIEW_LIMITS.text) })).not.toBeNull();
    expect(view({ type: "text", content: "c".repeat(VIEW_LIMITS.text + 1) })).toBeNull();
    expect(view({ ...NODE_SAMPLES.metric, value: "v".repeat(VIEW_LIMITS.value + 1) })).toBeNull();
    expect(
      view({
        type: "table",
        columns: [{ label: "c" }],
        rows: [["x".repeat(VIEW_LIMITS.cell + 1)]],
      }),
    ).toBeNull();
  });

  it("limits table size and trend length", () => {
    const table = (columns: number, rows: number) => ({
      type: "table",
      columns: range(columns).map((index) => ({ label: `c${index}` })),
      rows: range(rows).map(() => range(columns)),
    });
    expect(view(table(VIEW_LIMITS.tableColumns, VIEW_LIMITS.tableRows))).not.toBeNull();
    expect(view(table(VIEW_LIMITS.tableColumns + 1, 1))).toBeNull();
    expect(view(table(1, VIEW_LIMITS.tableRows + 1))).toBeNull();
    expect(view({ ...NODE_SAMPLES.metric, trend: range(VIEW_LIMITS.trendPoints) })).not.toBeNull();
    expect(view({ ...NODE_SAMPLES.metric, trend: range(VIEW_LIMITS.trendPoints + 1) })).toBeNull();
  });
});

describe("hostile input", () => {
  const hostile: [string, string][] = [
    ["empty", ""],
    ["not JSON", "{"],
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"<script>alert(1)</script>"'],
    ["a number", "1"],
    ["deep arrays", "[".repeat(15_000) + "]".repeat(15_000)],
    [
      "a deep tree",
      '{"root":' +
        '{"type":"stack","children":['.repeat(1_000) +
        '{"type":"text","content":"x"}' +
        "]}".repeat(1_000) +
        "}",
    ],
    ["a huge array", `{"root":{"type":"stack","children":[${"0,".repeat(15_000)}0]}}`],
    [
      "an overflowing number",
      '{"type":"bar","title":"t","labels":["a"],"series":[{"name":"s","values":[1e999]}]}',
    ],
    [
      "a negative overflow",
      '{"type":"bar","title":"t","labels":["a"],"series":[{"name":"s","values":[-1e999]}]}',
    ],
    [
      "a string value",
      '{"type":"bar","title":"t","labels":["a"],"series":[{"name":"s","values":["1"]}]}',
    ],
    [
      "a null value",
      '{"type":"bar","title":"t","labels":["a"],"series":[{"name":"s","values":[null]}]}',
    ],
    [
      "an unknown kind",
      '{"type":"radar","title":"t","labels":["a"],"series":[{"name":"s","values":[1]}]}',
    ],
    ["an unknown node", '{"root":{"type":"html","content":"<b>x</b>"}}'],
    ["children that are not nodes", '{"root":{"type":"stack","children":["x",1,null,[]]}}'],
    [
      "children that are not a list",
      '{"root":{"type":"stack","children":{"0":{"type":"text","content":"x"}}}}',
    ],
    ["a root that is a list", '{"root":[{"type":"text","content":"x"}]}'],
  ];

  it.each(hostile)("returns null for %s", (_name, source) => {
    expect(parseChatView(PIMI_CHART_FENCE, source)).toBeNull();
    expect(parseChatView(PIMI_VIEW_FENCE, source)).toBeNull();
  });

  // Unknown fields are dropped, so a stray key never reaches a renderer and never costs the chart.
  const extraFields: [string, string][] = [
    [
      "an unknown chart key",
      '{"type":"bar","title":"t","labels":["a"],"series":[{"name":"s","values":[1]}],"color":"#f00"}',
    ],
    [
      "an unknown series key",
      '{"type":"bar","title":"t","labels":["a"],"series":[{"name":"s","values":[1],"color":"red"}]}',
    ],
    [
      "a prototype key",
      '{"type":"bar","title":"t","labels":["a"],"series":[{"name":"s","values":[1]}],"__proto__":{"polluted":true}}',
    ],
    [
      "a constructor key",
      '{"type":"bar","title":"t","labels":["a"],"series":[{"name":"s","values":[1]}],"constructor":{"prototype":{"polluted":true}}}',
    ],
    [
      "a nested prototype key",
      '{"root":{"type":"text","content":"x","__proto__":{"type":"badge"}}}',
    ],
    ["a node with a link", '{"root":{"type":"text","content":"x","href":"https://example.com"}}'],
    ["an unknown view key", '{"root":{"type":"text","content":"x"},"script":"alert(1)"}'],
    [
      "a node with a style",
      '{"root":{"type":"badge","label":"x","tone":"neutral","style":{"color":"red"}}}',
    ],
  ];

  it.each(extraFields)("drops %s", (_name, source) => {
    const fence = source.includes('"root"') ? PIMI_VIEW_FENCE : PIMI_CHART_FENCE;
    const parsed = parseChatView(fence, source);
    expect(parsed).not.toBeNull();
    const text = JSON.stringify(parsed);
    for (const key of ["color", "href", "style", "script", "polluted", "prototype"])
      expect(text).not.toContain(`"${key}"`);
  });

  it("leaves prototypes untouched", () => {
    parseChatView(
      PIMI_VIEW_FENCE,
      '{"__proto__":{"polluted":true},"root":{"type":"text","content":"x","__proto__":{"polluted":true}}}',
    );
    expect(Reflect.get({}, "polluted")).toBeUndefined();
  });

  it("keeps markup and URLs as plain, size-capped text", () => {
    const markup = '<img src=x onerror="alert(1)"> javascript:alert(1) https://example.com';
    expect(view({ type: "text", content: markup })?.root).toEqual({
      type: "text",
      content: markup,
    });
    expect(chart({ ...BAR, title: markup })?.root).toMatchObject({ title: markup });
    expect(view({ type: "badge", label: "<svg onload=alert(1)>".repeat(4) })).toBeNull();
  });
});

it("recognizes both fences in any letter case", () => {
  expect(viewFenceOf("PIMI-Chart")).toBe(PIMI_CHART_FENCE);
  expect(viewFenceOf("pimi-view")).toBe(PIMI_VIEW_FENCE);
  expect(viewFenceOf("pimi-artifact")).toBeNull();
  expect(viewFenceOf(null)).toBeNull();
});
