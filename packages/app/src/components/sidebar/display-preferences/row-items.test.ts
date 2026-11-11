import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_ROW_ITEMS, parseSidebarRowItems } from "./row-items";

describe("parseSidebarRowItems", () => {
  it("shows operational metadata but hides identity badges by default", () => {
    expect(DEFAULT_SIDEBAR_ROW_ITEMS).toEqual({
      branch: false,
      project: false,
      host: true,
      changeRequest: true,
      services: true,
      labels: true,
    });
  });

  it("applies stored overrides", () => {
    expect(parseSidebarRowItems({ services: false })).toEqual({
      ...DEFAULT_SIDEBAR_ROW_ITEMS,
      services: false,
    });
  });

  it("leaves items absent from storage at their default", () => {
    // An absent key takes the item's explicit product default.
    expect(parseSidebarRowItems({ host: false })).toEqual({
      ...DEFAULT_SIDEBAR_ROW_ITEMS,
      host: false,
    });
  });

  it("ignores unknown keys and non-boolean values", () => {
    expect(
      parseSidebarRowItems({ checks: false, nonsense: false, services: null, host: false }),
    ).toEqual({ ...DEFAULT_SIDEBAR_ROW_ITEMS, host: false });
  });

  it.each([[null], [undefined], ["diff"], [42], [["services"]]])(
    "falls back to defaults for %s",
    (value) => {
      expect(parseSidebarRowItems(value)).toEqual(DEFAULT_SIDEBAR_ROW_ITEMS);
    },
  );

  it("does not hand back the shared default object", () => {
    const parsed = parseSidebarRowItems({ services: false });
    expect(parsed).not.toBe(DEFAULT_SIDEBAR_ROW_ITEMS);
    expect(DEFAULT_SIDEBAR_ROW_ITEMS.services).toBe(true);
  });
});
