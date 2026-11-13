import { useEffect, useMemo, useState } from "react";
import { encodeAttachmentsForSend } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { isWeb } from "@/constants/platform";
import { MAX_ATTACK_ANNOTATION_IMAGE_BASE64_CHARS } from "@pimi/protocol/attack/types";

const MAX_WIDTH = 640;
const QUALITY_STEPS = [0.8, 0.6, 0.4] as const;

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () =>
      reject(new Error("The element screenshot could not be decoded.")),
    );
    image.src = dataUrl;
  });
}

/**
 * The owner's element screenshot as a JPEG at most 640 px wide, base64 without a prefix, small
 * enough for the run definition. Null when the screenshot cannot be read or shrunk under the cap:
 * the annotation then reaches the agents as text only. Web only; native has no canvas here.
 */
export async function loadAnnotationImage(screenshot: AttachmentMetadata): Promise<string | null> {
  if (!isWeb) return null;
  try {
    const encoded = await encodeAttachmentsForSend([screenshot]);
    const first = encoded?.[0];
    if (!first) return null;
    const image = await loadImage(`data:${first.mimeType};base64,${first.data}`);
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;
    const scale = Math.min(1, MAX_WIDTH / image.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    // JPEG has no alpha; a transparent element would otherwise turn black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of QUALITY_STEPS) {
      const url = canvas.toDataURL("image/jpeg", quality);
      const base64 = url.slice(url.indexOf(",") + 1);
      if (base64.length <= MAX_ATTACK_ANNOTATION_IMAGE_BASE64_CHARS) return base64;
    }
    return null;
  } catch (error) {
    console.warn("[attack] annotation screenshot skipped", error);
    return null;
  }
}

export interface DesktopRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The marked region of a desktop still as a JPEG at most 640 px wide, base64 without a prefix. */
export async function cropDesktopRegion(
  stillUri: string,
  region: DesktopRegion,
): Promise<string | null> {
  if (!isWeb) return null;
  try {
    const image = await loadImage(stillUri);
    const scale = Math.min(1, MAX_WIDTH / region.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(region.width * scale));
    canvas.height = Math.max(1, Math.round(region.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      image,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    for (const quality of QUALITY_STEPS) {
      const url = canvas.toDataURL("image/jpeg", quality);
      const base64 = url.slice(url.indexOf(",") + 1);
      if (base64.length <= MAX_ATTACK_ANNOTATION_IMAGE_BASE64_CHARS) return base64;
    }
    return null;
  } catch (error) {
    console.warn("[attack] desktop annotation crop skipped", error);
    return null;
  }
}

/**
 * Screenshots for the given attachments, by attachment id, filled in as each finishes. An id that
 * failed stays absent, so the annotation goes out as text.
 */
export function useAnnotationImages(
  screenshots: readonly (AttachmentMetadata | undefined)[],
): ReadonlyMap<string, string> {
  const [images, setImages] = useState<ReadonlyMap<string, string>>(new Map());
  const [tried] = useState(() => new Set<string>());
  const pending = useMemo(
    () =>
      screenshots.filter(
        (item): item is AttachmentMetadata => item !== undefined && !tried.has(item.id),
      ),
    [screenshots, tried],
  );
  useEffect(() => {
    for (const screenshot of pending) {
      tried.add(screenshot.id);
      void loadAnnotationImage(screenshot).then((base64) => {
        if (base64) setImages((current) => new Map(current).set(screenshot.id, base64));
        return base64;
      });
    }
  }, [pending, tried]);
  return images;
}
