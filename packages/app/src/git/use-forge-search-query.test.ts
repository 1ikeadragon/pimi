import { describe, expect, it } from "vitest";
import { buildForgeSearchQueryOptions, forgeSearchQueryKey } from "./use-forge-search-query";

describe("forgeSearchQueryKey", () => {
  it("keeps the shared cache key shape for no-kinds searches", () => {
    expect(forgeSearchQueryKey("server-1", "/repo", "  123  ")).toEqual([
      "forge-search",
      "server-1",
      "/repo",
      "123",
    ]);
  });

  it("adds a deterministic kinds key when kinds are specified", () => {
    expect(forgeSearchQueryKey("server-1", "/repo", "123", ["change_request", "issue"])).toEqual([
      "forge-search",
      "server-1",
      "/repo",
      "123",
      "change_request,issue",
    ]);
  });
});

describe("buildForgeSearchQueryOptions", () => {
  it("forwards kinds to the forge search request when specified", async () => {
    const requests: unknown[] = [];
    const query = buildForgeSearchQueryOptions({
      client: {
        async searchForge(options) {
          requests.push(options);
          return {
            items: [],
            authState: "authenticated",
            error: null,
            requestId: "request-1",
          };
        },
      },
      serverId: "server-1",
      cwd: "/repo",
      query: " 123 ",
      kinds: ["change_request"],
      enabled: true,
    });

    await query.queryFn();

    expect(requests).toEqual([
      { cwd: "/repo", query: "123", limit: 20, kinds: ["change_request"] },
    ]);
  });

  it("interprets modern search payloads at the query boundary", async () => {
    const query = buildForgeSearchQueryOptions({
      client: {
        async searchForge() {
          return {
            items: [
              {
                kind: "issue",
                number: 23,
                title: "Keep this",
                url: "https://gitlab.com/acme/repo/-/issues/23",
                state: "open",
                body: null,
                labels: [],
              },
              { kind: "future_kind", futureField: true },
            ],
            authState: "future_auth_state",
            error: null,
            requestId: "forge-request",
          };
        },
      },
      serverId: "server-1",
      cwd: "/repo",
      query: "23",
      enabled: true,
    });

    const result = await query.queryFn();

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("issue");
    expect(result.authState).toBe("unauthenticated");
  });

  it("invokes forge search bound to the client so this-dependent methods work", async () => {
    const client = new ThisDependentSearchClient();

    const query = buildForgeSearchQueryOptions({
      client,
      serverId: "server-1",
      cwd: "/repo",
      query: " 789 ",
      enabled: true,
    });

    const result = await query.queryFn();

    expect(result.requestId).toBe("forge.search.request");
    expect(client.requests).toEqual([{ cwd: "/repo", query: "789", limit: 20 }]);
  });
});

class ThisDependentSearchClient {
  readonly requests: unknown[] = [];

  private send(requestId: string, options: { cwd: string; query: string; limit?: number }) {
    this.requests.push(options);
    return Promise.resolve({
      items: [],
      authState: "authenticated" as const,
      error: null,
      requestId,
    });
  }

  async searchForge(options: { cwd: string; query: string; limit?: number }) {
    return this.send("forge.search.request", options);
  }
}
