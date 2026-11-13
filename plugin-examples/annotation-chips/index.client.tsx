import type { PluginClientContext } from "@pimi/plugin/client";
import { AnnotationChip } from "./client/chip";

export default function contribute(client: PluginClientContext) {
  const removeRenderer = client.addAttachmentRenderer({
    kind: "annotation",
    Component: AnnotationChip,
  });
  return () => {
    void removeRenderer();
  };
}
