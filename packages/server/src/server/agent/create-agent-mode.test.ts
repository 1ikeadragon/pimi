import { describe, expect, it } from "vitest";
import { resolveAndValidateCreateAgentMode } from "./create-agent-mode.js";

const CLAUDE_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
const OPENCODE_MODES = ["build", "plan"];
const CODEX_MODES = ["auto", "full-access"];

function agentParent(provider: string, modeId: string | null, isUnattended = false) {
  return { provider, modeId, isUnattended };
}

describe("resolveAndValidateCreateAgentMode", () => {
  it("returns the requested mode when it is valid for the target provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "plan",
      targetProvider: "opencode",
      parent: null,
      unattended: false,
      availableModes: OPENCODE_MODES,
    });
    expect(resolved).toBe("plan");
  });

  it("throws when the requested mode is invalid for the target provider", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: "bypassPermissions",
        targetProvider: "opencode",
        parent: null,
        unattended: false,
        availableModes: OPENCODE_MODES,
      }),
    ).toThrow(
      "Invalid mode 'bypassPermissions' for provider 'opencode'. Available modes: build, plan",
    );
  });

  it("returns undefined (provider default) when no mode and no caller", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: null,
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBeUndefined();
  });

  it("inherits the caller mode when caller and target share a provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: agentParent("claude", "bypassPermissions"),
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBe("bypassPermissions");
  });

  it("returns undefined when same-provider caller has no mode", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: agentParent("claude", null),
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBeUndefined();
  });

  it("starts a cross-provider agent in the target's default mode", () => {
    expect(
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "opencode",
        parent: agentParent("claude", "bypassPermissions"),
        unattended: false,
        availableModes: OPENCODE_MODES,
      }),
    ).toBeUndefined();
  });

  it("uses the target's default mode when the caller has no mode", () => {
    expect(
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "codex",
        parent: agentParent("opencode", null),
        unattended: false,
        availableModes: CODEX_MODES,
      }),
    ).toBeUndefined();
  });

  it("uses the provider default when the cross-provider target has no modes", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "pi",
      parent: agentParent("codex", "auto"),
      unattended: false,
      availableModes: [],
      targetUnattendedMode: undefined,
    });

    expect(resolved).toBeUndefined();
  });

  it("uses the provider default when an unattended parent targets a provider with no modes", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "pi",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: [],
      targetUnattendedMode: undefined,
    });

    expect(resolved).toBeUndefined();
  });

  it("passes through an explicit mode when the target provider's modes are unknown", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "default",
      targetProvider: "zai-custom",
      parent: null,
      unattended: false,
      availableModes: undefined,
    });
    expect(resolved).toBe("default");
  });

  it("uses the target's default mode when its modes are unknown", () => {
    expect(
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "zai-custom",
        parent: agentParent("claude", "default"),
        unattended: false,
        availableModes: undefined,
      }),
    ).toBeUndefined();
  });

  it("inherits target's unattended mode when caller is unattended cross-provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "codex",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("full-access");
  });

  it("inherits target's unattended mode for unattended creation without a parent", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "codex",
      parent: null,
      unattended: true,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("full-access");
  });

  it("does not carry an unattended mode to a child of an attended caller", () => {
    expect(
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "codex",
        parent: agentParent("claude", "default"),
        unattended: false,
        availableModes: CODEX_MODES,
        targetUnattendedMode: "full-access",
      }),
    ).toBeUndefined();
  });

  it("uses the target's default mode when it has no unattended mode", () => {
    expect(
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "zai-custom",
        parent: agentParent("claude", "bypassPermissions", true),
        unattended: false,
        availableModes: undefined,
        targetUnattendedMode: undefined,
      }),
    ).toBeUndefined();
  });

  it("explicit mode wins over unattended inheritance", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "auto",
      targetProvider: "codex",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("auto");
  });
});
