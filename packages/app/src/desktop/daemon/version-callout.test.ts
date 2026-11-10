import { describe, expect, it } from "vitest";
import { resolveDaemonVersionCallout, type DaemonVersionCalloutInput } from "./version-callout";

function input(overrides: Partial<DaemonVersionCalloutInput> = {}): DaemonVersionCalloutInput {
  return {
    isDesktopApp: true,
    manageBuiltInDaemon: true,
    isDaemonStarting: false,
    appVersion: "1.2.3",
    daemon: { status: "running", desktopManaged: true, version: "1.2.2" },
    connectedDaemonVersion: null,
    isRestarting: false,
    restartError: null,
    isDismissed: false,
    ...overrides,
  };
}

describe("resolveDaemonVersionCallout", () => {
  it("offers a restart while the desktop-managed daemon is on another version", () => {
    expect(resolveDaemonVersionCallout(input())).toEqual({
      id: "desktop-daemon-version",
      priority: 150,
      testID: "daemon-version-callout",
      title: "Daemon is on an older version",
      description: "The local daemon is on 1.2.2 and this app is on 1.2.3.",
      warning: "Restarting it interrupts running agents.",
      variant: "default",
      actionLabel: "Restart daemon",
      actionDisabled: false,
    });
  });

  it("stays hidden when the versions match", () => {
    const daemon = { status: "running", desktopManaged: true, version: "v1.2.3" } as const;

    expect(resolveDaemonVersionCallout(input({ daemon }))).toBeNull();
  });

  it("stays hidden when either version is unknown", () => {
    const daemon = { status: "running", desktopManaged: true, version: null } as const;

    expect(resolveDaemonVersionCallout(input({ daemon }))).toBeNull();
    expect(resolveDaemonVersionCallout(input({ appVersion: null }))).toBeNull();
  });

  it("stays hidden for a daemon the user started", () => {
    const daemon = { status: "running", desktopManaged: false, version: "1.2.2" } as const;

    expect(resolveDaemonVersionCallout(input({ daemon }))).toBeNull();
  });

  it("stays hidden outside the desktop app and while daemon management is paused", () => {
    expect(resolveDaemonVersionCallout(input({ isDesktopApp: false }))).toBeNull();
    expect(resolveDaemonVersionCallout(input({ manageBuiltInDaemon: false }))).toBeNull();
  });

  it("stays hidden until the daemon is known to be running", () => {
    const stopped = { status: "stopped", desktopManaged: true, version: "1.2.2" } as const;

    expect(resolveDaemonVersionCallout(input({ daemon: null }))).toBeNull();
    expect(resolveDaemonVersionCallout(input({ daemon: stopped }))).toBeNull();
    expect(resolveDaemonVersionCallout(input({ isDaemonStarting: true }))).toBeNull();
  });

  it("trusts the version the connected daemon reports over the last desktop status", () => {
    expect(resolveDaemonVersionCallout(input({ connectedDaemonVersion: "1.2.3" }))).toBeNull();
    expect(
      resolveDaemonVersionCallout(
        input({
          daemon: { status: "running", desktopManaged: true, version: "1.2.3" },
          connectedDaemonVersion: "1.2.1",
        }),
      )?.description,
    ).toBe("The local daemon is on 1.2.1 and this app is on 1.2.3.");
  });

  it("stays hidden once dismissed", () => {
    expect(resolveDaemonVersionCallout(input({ isDismissed: true }))).toBeNull();
    expect(
      resolveDaemonVersionCallout(input({ isDismissed: true, restartError: "boom" })),
    ).toBeNull();
  });

  it("shows progress while restarting, whatever the daemon reports meanwhile", () => {
    expect(
      resolveDaemonVersionCallout(input({ isRestarting: true, daemon: null, isDismissed: true })),
    ).toMatchObject({
      description: "Restarting the local daemon…",
      warning: null,
      actionLabel: "Restarting…",
      actionDisabled: true,
    });
  });

  it("keeps a failed restart visible with a retry", () => {
    expect(
      resolveDaemonVersionCallout(input({ restartError: "Daemon failed to start", daemon: null })),
    ).toMatchObject({
      title: "Daemon restart failed",
      description: "Daemon failed to start",
      variant: "error",
      actionLabel: "Retry",
      actionDisabled: false,
    });
  });
});
