import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveCliInstallSourcePath, resolveCliShimPath } from "./path";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Pimi.app/Contents/MacOS/Pimi",
        shimPath: "/Applications/Pimi.app/Contents/Resources/bin/pimi",
      }),
    ).toBe("/Applications/Pimi.app/Contents/Resources/bin/pimi");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_paseo123/paseo",
        shimPath: "/tmp/.mount_paseo123/resources/bin/pimi",
        appImagePath: "/home/user/Applications/Pimi.AppImage",
      }),
    ).toBe("/home/user/Applications/Pimi.AppImage");
  });

  it("uses the bundled shim for packaged linux installs outside an AppImage", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Pimi/Pimi",
        shimPath: "/opt/Pimi/resources/bin/pimi",
      }),
    ).toBe("/opt/Pimi/resources/bin/pimi");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Pimi\\Pimi.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Pimi\\resources\\bin\\pimi.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Pimi\\resources\\bin\\pimi.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Pimi/paseo",
        shimPath: "/opt/Pimi/resources/bin/pimi",
      }),
    ).toBe("/opt/Pimi/resources/bin/pimi");
  });
});

describe("CLI executable selection", () => {
  const resolveWorkspaceCli = () => createRequire(import.meta.url).resolve("@pimi/cli/bin/pimi");

  it("uses the workspace CLI for an unpackaged Electron launcher", () => {
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/nix/store/electron/bin/electron",
        resolveWorkspaceCli,
      }),
    ).toBe(resolveWorkspaceCli());
  });

  it("uses the application shim for a packaged launcher", () => {
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Pimi/paseo",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/opt/Pimi", "resources", "bin", "pimi"));
    expect(
      resolveCliShimPath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Pimi.app/Contents/MacOS/Pimi",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/Applications/Pimi.app", "Contents", "Resources", "bin", "pimi"));
  });
});
