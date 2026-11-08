import { describe, expect, it, vi } from "vitest";

vi.mock("./pimi-auto-updater", () => ({
  PimiAutoUpdater: class PimiAutoUpdater {
    check = vi.fn();
  },
}));

import { shouldInstallAppUpdateOnQuit } from "./auto-updater";

describe("shouldInstallAppUpdateOnQuit", () => {
  it("keeps Linux AppImage updates on the manual install path", () => {
    expect(shouldInstallAppUpdateOnQuit({ platform: "linux", isAppImage: true })).toBe(false);
    expect(shouldInstallAppUpdateOnQuit({ platform: "linux", isAppImage: false })).toBe(true);
    expect(shouldInstallAppUpdateOnQuit({ platform: "darwin", isAppImage: false })).toBe(true);
    expect(shouldInstallAppUpdateOnQuit({ platform: "win32", isAppImage: false })).toBe(true);
  });
});
