import { randomUUID } from "node:crypto";

// Documents the console shows in sandboxed iframes (Mermaid runtime, agent HTML previews).
// They live at pimi://frame/<token> so each carries its own CSP header. A srcdoc, data: or blob:
// frame inherits the console's CSP, which allows no inline script, and these documents need it.
export const SEALED_FRAME_HOST = "frame";

// Keep in sync with the meta policies these documents already carry:
// preview -> app/src/file-panels/html-preview-csp.ts, mermaid -> mermaid/build-runtime.mjs.
// `sandbox` gives the frame an opaque origin even if the iframe attribute were dropped.
const POLICIES = {
  preview: [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "sandbox allow-scripts",
  ].join("; "),
  mermaid: [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "img-src data: blob:",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "sandbox allow-scripts",
  ].join("; "),
} as const;

export type SealedFrameKind = keyof typeof POLICIES;

interface SealedFrame {
  ownerId: number;
  kind: SealedFrameKind;
  html: string;
}

// The console releases a document when its preview unmounts, and a window drops all of its
// documents when it navigates or closes, so the store holds only what is on screen.
const frames = new Map<string, SealedFrame>();

export function putSealedFrame(ownerId: number, kind: unknown, html: unknown): string {
  if (typeof kind !== "string" || !Object.hasOwn(POLICIES, kind) || typeof html !== "string") {
    throw new Error("Invalid sealed frame.");
  }
  const token = randomUUID();
  frames.set(token, { ownerId, kind: kind as SealedFrameKind, html });
  return `pimi://${SEALED_FRAME_HOST}/${token}`;
}

export function releaseSealedFrame(ownerId: number, url: unknown): void {
  const token = typeof url === "string" ? tokenOf(url) : null;
  if (token && frames.get(token)?.ownerId === ownerId) frames.delete(token);
}

export function releaseSealedFramesOwnedBy(ownerId: number): void {
  for (const [token, frame] of frames) {
    if (frame.ownerId === ownerId) frames.delete(token);
  }
}

export function sealedFrameResponse(request: Request): Response {
  const frame = request.method === "GET" ? frames.get(tokenOf(request.url) ?? "") : undefined;
  if (!frame) return new Response("Not found", { status: 404 });
  return new Response(frame.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": POLICIES[frame.kind],
      "cache-control": "no-store",
    },
  });
}

function tokenOf(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "pimi:" || parsed.host !== SEALED_FRAME_HOST) return null;
  return parsed.pathname.slice(1) || null;
}
