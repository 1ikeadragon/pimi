export const CLIENT_CAPS = {
  binaryChunkingV1: "binary_chunking_v1",
} as const;

export type ClientCapability = (typeof CLIENT_CAPS)[keyof typeof CLIENT_CAPS];
