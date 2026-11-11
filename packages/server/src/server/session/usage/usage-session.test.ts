import pino from "pino";
import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { UsageSession } from "./usage-session.js";

test("lists reports from usage sources", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const requested: Array<{ forceRefresh?: boolean; reportIds?: string[] }> = [];
  const entry = {
    id: "fixture:one",
    account: {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: "fixture",
    sourceLabel: "Fixture",
    report: { status: "available" as const, windows: [] },
  };
  const usage = new UsageSession({
    isEnabled: () => true,
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports(options) {
        requested.push({ forceRefresh: options.forceRefresh, reportIds: options.reportIds });
        options.onReport?.(entry);
        return [entry];
      },
    },
    logger: pino({ level: "silent" }),
  });

  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "list" });
  expect(requested).toEqual([{ forceRefresh: undefined, reportIds: undefined }]);
  expect(emitted).toEqual([
    { type: "usage.list_reports.update", payload: { requestId: "list", report: entry } },
    { type: "usage.list_reports.response", payload: { requestId: "list", error: null } },
  ]);
});

test("request failures terminate with an error response and no updates", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    isEnabled: () => true,
    emit: (message) => emitted.push(message),
    logger: pino({ level: "silent" }),
  });
  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "failed" });
  expect(emitted).toEqual([
    {
      type: "usage.list_reports.response",
      payload: { requestId: "failed", error: "Plugin runtime is unavailable" },
    },
  ]);
});

test("off rejects reports before runtime discovery and turning on restores reports", async () => {
  let enabled = false;
  let calls = 0;
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    isEnabled: () => enabled,
    emit: (message) => emitted.push(message),
    logger: pino({ level: "silent" }),
    runtime: {
      async listUsageReports() {
        calls++;
        return [];
      },
    },
  });
  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "off" });
  expect(calls).toBe(0);
  expect(emitted[0]).toMatchObject({ payload: { error: "Usage is off on this host." } });
  enabled = true;
  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "on" });
  expect(calls).toBe(1);
  expect(emitted[1]).toMatchObject({ payload: { error: null } });
});
