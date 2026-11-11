import { describe, expect, it } from "vitest";
import { resolvePluginPageState } from "./plugins-page-state";

describe("resolvePluginPageState", () => {
  it.each([
    ["offline", false, false, false, 0],
    ["loading", true, true, false, 0],
    ["error", true, false, true, 0],
    ["empty", true, false, false, 0],
    ["ready", true, false, false, 1],
  ] as const)("resolves %s", (expected, connected, loading, error, pluginCount) => {
    expect(resolvePluginPageState({ connected, loading, error, pluginCount })).toBe(expected);
  });
});
