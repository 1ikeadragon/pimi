import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { AgentImageRef } from "@pimi/protocol/agent-types";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";

const fetched = new Map<string, Promise<AttachmentMetadata | null>>();

function fetchAgentImage(
  client: DaemonClient,
  agentId: string,
  ref: AgentImageRef,
): Promise<AttachmentMetadata | null> {
  const key = `${agentId}:${ref.imageId}`;
  const cached = fetched.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const image = await client.requestAgentImage({ agentId, imageId: ref.imageId });
    return await persistAttachmentFromDataUrl({
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
      mimeType: image.mimeType,
      id: `agent-image-${ref.imageId}`,
    });
  })().catch((error) => {
    // A failed fetch is retried the next time the message renders.
    fetched.delete(key);
    console.warn("[agent-images] Failed to fetch image", { agentId, imageId: ref.imageId, error });
    return null;
  });
  fetched.set(key, pending);
  return pending;
}

type ImageSlots = Array<AttachmentMetadata | null>;

function fillSlot(
  setImages: Dispatch<SetStateAction<ImageSlots>>,
  index: number,
  metadata: AttachmentMetadata,
): void {
  setImages((current) => {
    const next = [...current];
    next[index] = metadata;
    return next;
  });
}

/**
 * Fetches the images a message refers to into the local attachment store. The result lines up
 * with `refs`; an entry is null while it loads, when the daemon did not keep it or the fetch fails.
 */
export function useAgentImages(
  client: DaemonClient | null | undefined,
  agentId: string | undefined,
  refs: readonly AgentImageRef[] | undefined,
): ImageSlots {
  const [images, setImages] = useState<ImageSlots>([]);
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const refsKey = refs?.map((ref) => (ref.unavailable ? "-" : ref.imageId)).join(",") ?? "";

  useEffect(() => {
    const current = refsRef.current;
    if (!client || !agentId || !current || current.length === 0) {
      setImages([]);
      return;
    }
    let cancelled = false;
    setImages(current.map(() => null));
    current.forEach((ref, index) => {
      if (ref.unavailable) return;
      fetchAgentImage(client, agentId, ref)
        .then((metadata) => {
          if (!cancelled && metadata) fillSlot(setImages, index, metadata);
          return metadata;
        })
        .catch(() => null);
    });
    return () => {
      cancelled = true;
    };
  }, [client, agentId, refsKey]);

  return images;
}
