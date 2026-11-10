import { describe, expect, it } from "vitest";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { buildTimelinePromptIndex, buildTimelinePromptPage } from "./timeline-prompt-index.js";

describe("buildTimelinePromptIndex", () => {
  it("indexes every canonical user prompt with a stable timeline position", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 3,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "  First\n\n   prompt  " },
      },
      {
        seq: 4,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "response" },
      },
      {
        seq: 8,
        timestamp: "2026-01-01T00:00:02.000Z",
        item: { type: "user_message", text: "Second prompt" },
      },
    ];

    expect(buildTimelinePromptIndex("epoch-1", rows)).toEqual({
      epoch: "epoch-1",
      prompts: [
        { seq: 3, timestamp: "2026-01-01T00:00:00.000Z", preview: "First prompt" },
        { seq: 8, timestamp: "2026-01-01T00:00:02.000Z", preview: "Second prompt" },
      ],
    });
  });

  it("bounds previews without indexing assistant rows", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "x".repeat(200) },
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "ignored" },
      },
    ];

    const result = buildTimelinePromptIndex("epoch-1", rows);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.preview).toHaveLength(120);
    expect(result.prompts[0]?.preview.endsWith("…")).toBe(true);
  });
});

describe("buildTimelinePromptPage", () => {
  function conversation(): AgentTimelineRow[] {
    return [1, 2, 3, 4, 5].flatMap((turn) => [
      {
        seq: turn * 10,
        timestamp: `2026-01-01T00:00:0${turn}.000Z`,
        item: { type: "user_message" as const, text: `prompt ${turn}\nwith ${"x".repeat(200)}` },
      },
      {
        seq: turn * 10 + 1,
        timestamp: `2026-01-01T00:00:0${turn}.500Z`,
        item: { type: "assistant_message" as const, text: `response ${turn}` },
      },
    ]);
  }

  function page(input: { beforeSeq?: number; limit: number }) {
    const result = buildTimelinePromptPage("epoch-1", conversation(), input);
    return {
      seqs: result.prompts.map((prompt) => prompt.seq),
      firstLines: result.prompts.map((prompt) => prompt.text.split("\n")[0]),
      hasOlder: result.hasOlder,
    };
  }

  it("returns the newest prompts with their full text, oldest first", () => {
    const result = buildTimelinePromptPage("epoch-1", conversation(), { limit: 2 });

    expect(result.epoch).toBe("epoch-1");
    expect(result.hasOlder).toBe(true);
    expect(result.prompts.map((prompt) => prompt.seq)).toEqual([40, 50]);
    expect(result.prompts[1]?.text).toBe(`prompt 5\nwith ${"x".repeat(200)}`);
    expect(result.prompts[1]?.preview).toHaveLength(120);
  });

  it("pages backwards from a prompt until none are older", () => {
    expect(page({ beforeSeq: 40, limit: 2 })).toEqual({
      seqs: [20, 30],
      firstLines: ["prompt 2", "prompt 3"],
      hasOlder: true,
    });
    expect(page({ beforeSeq: 20, limit: 2 })).toEqual({
      seqs: [10],
      firstLines: ["prompt 1"],
      hasOlder: false,
    });
    expect(page({ beforeSeq: 10, limit: 2 })).toEqual({
      seqs: [],
      firstLines: [],
      hasOlder: false,
    });
  });

  it("caps an oversized page request", () => {
    const rows: AgentTimelineRow[] = Array.from({ length: 150 }, (_, index) => ({
      seq: index + 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      item: { type: "user_message", text: `prompt ${index + 1}` },
    }));

    const result = buildTimelinePromptPage("epoch-1", rows, { limit: 10_000 });

    expect(result.prompts).toHaveLength(100);
    expect(result.prompts.at(-1)?.seq).toBe(150);
    expect(result.hasOlder).toBe(true);
  });
});
