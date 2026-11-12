import { useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { AgentImageRef } from "@pimi/protocol/agent-types";
import { persistAttachmentFromBytes } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";

/** How one image a message refers to resolves on this client. */
export type AgentImageSlot =
  | { state: "loading" }
  /** An http(s) image the daemon never stored; the view loads it straight from the URL. */
  | { state: "remote"; uri: string }
  | { state: "ready"; metadata: AttachmentMetadata }
  /** The daemon no longer has the bytes, or could not be reached for them. */
  | { state: "missing" }
  /** The daemon refused to keep it, so there is nothing to fetch. */
  | { state: "too_large" | "unsupported" };

const MAX_CONCURRENT_FETCHES = 3;

// Settled results by agent and image id. A transport failure is not stored, so the next render
// of the row tries again; "not found" is stored because the bytes are gone, not late.
const settled = new Map<string, AttachmentMetadata | "missing">();
const inFlight = new Map<string, Promise<AttachmentMetadata | "missing" | null>>();
const waiting: Array<() => void> = [];
let running = 0;

function cacheKey(agentId: string, imageId: string): string {
  return `${agentId}:${imageId}`;
}

async function runLimited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_FETCHES) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function fetchAgentImage(
  client: DaemonClient,
  agentId: string,
  ref: AgentImageRef,
): Promise<AttachmentMetadata | "missing" | null> {
  const key = cacheKey(agentId, ref.imageId);
  const known = settled.get(key);
  if (known) return Promise.resolve(known);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = runLimited(async () => {
    const image = await client.requestAgentImage({ agentId, imageId: ref.imageId });
    return await persistAttachmentFromBytes({
      bytes: image.bytes,
      mimeType: image.mimeType,
      id: `agent-image-${ref.imageId}`,
    });
  })
    .then((metadata) => {
      settled.set(key, metadata);
      return metadata;
    })
    .catch((error: unknown) => {
      if (error instanceof Error && /not found/i.test(error.message)) {
        settled.set(key, "missing");
        return "missing" as const;
      }
      console.warn("[agent-images] Failed to fetch image", {
        agentId,
        imageId: ref.imageId,
        error,
      });
      return null;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

function initialSlot(agentId: string | undefined, ref: AgentImageRef): AgentImageSlot {
  if (ref.remoteUrl) return { state: "remote", uri: ref.remoteUrl };
  if (ref.unavailable) return { state: ref.unavailable };
  const known = agentId ? settled.get(cacheKey(agentId, ref.imageId)) : undefined;
  if (known === "missing") return { state: "missing" };
  return known ? { state: "ready", metadata: known } : { state: "loading" };
}

/**
 * Fetches the images a message refers to into the local attachment store, at most three at a
 * time, and only while `enabled` (the row is on screen). The result lines up with `refs`.
 */
export function useAgentImages(
  client: DaemonClient | null | undefined,
  agentId: string | undefined,
  refs: readonly AgentImageRef[] | undefined,
  enabled = true,
): AgentImageSlot[] {
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const refsKey =
    refs
      ?.map((ref) => (ref.unavailable ? `${ref.imageId}:${ref.unavailable}` : ref.imageId))
      .join(",") ?? "";
  const [slots, setSlots] = useState<AgentImageSlot[]>(() =>
    (refs ?? []).map((ref) => initialSlot(agentId, ref)),
  );

  useEffect(() => {
    const current = refsRef.current ?? [];
    setSlots(current.map((ref) => initialSlot(agentId, ref)));
    if (!client || !agentId || !enabled) return;
    let cancelled = false;
    const fill = (index: number, result: AttachmentMetadata | "missing") => {
      setSlots((previous) => {
        const next = [...previous];
        next[index] =
          result === "missing" ? { state: "missing" } : { state: "ready", metadata: result };
        return next;
      });
    };
    current.forEach((ref, index) => {
      if (ref.unavailable || ref.remoteUrl) return;
      fetchAgentImage(client, agentId, ref)
        .then((result) => {
          if (!cancelled && result !== null) fill(index, result);
          return result;
        })
        .catch(() => null);
    });
    return () => {
      cancelled = true;
    };
  }, [client, agentId, refsKey, enabled]);

  return slots;
}
