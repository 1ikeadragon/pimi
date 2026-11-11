/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSkills } from "./use-agent-skills";

const runtime = vi.hoisted(() => ({
  connected: true,
  clients: new Map<string, { getAgentSkillsStatus: ReturnType<typeof vi.fn> }>(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => runtime.clients.get(serverId) ?? null,
  useHostRuntimeIsConnected: () => runtime.connected,
}));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

describe("host agent skills", () => {
  beforeEach(() => {
    runtime.connected = true;
    runtime.clients.clear();
  });

  it("reads status from the selected host client", async () => {
    const local = { getAgentSkillsStatus: vi.fn() };
    const remote = {
      getAgentSkillsStatus: vi.fn(async () => ({
        state: "not-installed",
        ops: [],
        available: ["paseo"],
        installed: [],
        selection: { mode: "all" },
      })),
    };
    runtime.clients.set("local", local);
    runtime.clients.set("remote", remote);

    const { result } = renderHook(() => useAgentSkills("remote"), { wrapper });
    await waitFor(() => expect(result.current.status?.available).toEqual(["paseo"]));
    expect(remote.getAgentSkillsStatus).toHaveBeenCalledOnce();
    expect(local.getAgentSkillsStatus).not.toHaveBeenCalled();
  });
});
