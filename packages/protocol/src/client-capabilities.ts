export const CLIENT_CAPS = {
  binaryChunkingV1: "binary_chunking_v1",
  helloRejection: "hello_rejection",
  // Clients outside the Paseo app version series can explicitly accept provider IDs.
  allProviders: "all_providers",
  reasoningMergeEnum: "reasoning_merge_enum",
  browserHost: "browser_host",
} as const;

export type ClientCapability = (typeof CLIENT_CAPS)[keyof typeof CLIENT_CAPS];
