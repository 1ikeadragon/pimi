import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { FileVersion } from "@pimi/protocol/messages";
import {
  persistAttachmentFromBytes,
  releaseAttachmentPreviewUrl,
  resolveAttachmentPreviewUrl,
} from "@/attachments/service";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import type { FileObservation, FileSession } from "./handle";

/** A file session over a daemon connection. */
export function createDaemonFileSession(client: DaemonClient): FileSession {
  return {
    async observe(target, onObservation) {
      const classify = (version: FileVersion): FileObservation => {
        if (version.status !== "ready") return version;
        if (!version.kind || !version.mimeType) {
          return { ...version, status: "error", error: "The file has no kind." };
        }
        return { ...version, kind: version.kind, mimeType: version.mimeType };
      };
      const subscription = await client.subscribeFile(target, (version) =>
        onObservation(classify(version)),
      );
      return {
        initial: classify(subscription.initial),
        unsubscribe() {
          void subscription.unsubscribe();
        },
      };
    },
    async read(target) {
      return client.readFile(target.cwd, target.path);
    },
    async write({ target, content, ...expected }) {
      if (typeof content === "string") {
        return client.writeFile({ ...target, content, ...expected });
      }
      return client.writeFile({
        ...target,
        content: bytesToBase64(content),
        contentEncoding: "base64",
        ...expected,
      });
    },
    async createUrl({ target, bytes, mimeType }) {
      const attachment = await persistAttachmentFromBytes({
        id: createPreviewAttachmentId({
          mimeType,
          path: `${target.cwd}/${target.path}`,
          contentLength: bytes.byteLength,
          contentKey: String(Date.now()),
        }),
        bytes,
        mimeType,
        fileName: getFileNameFromPath(target.path),
      });
      const url = await resolveAttachmentPreviewUrl(attachment);
      return {
        url,
        release() {
          void releaseAttachmentPreviewUrl({ attachment, url });
        },
      };
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
