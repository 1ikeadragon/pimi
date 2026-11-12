import type { PluginClientContext } from "@pimi/plugin/client";
import { AnnotationChip } from "./client/chip";

export default function contribute(client: PluginClientContext) {
  const removeRenderer = client.addAttachmentRenderer({
    kind: "annotation",
    Component: AnnotationChip,
  });

  // Backspace with the caret at the start of the text removes the newest annotation, the way a
  // chip in an inline editor would. Key events exist on web and desktop only.
  let releaseKeys: (() => void) | null = null;
  const bind = () => {
    releaseKeys?.();
    releaseKeys =
      client.composer.active()?.onKeyDown((event) => {
        const composer = client.composer.active();
        if (!composer) return;
        if (event.key !== "Backspace" || event.hasModifier) return;
        if (event.selection.start !== 0 || event.selection.end !== 0) return;
        const last = composer.attachments.list().at(-1);
        if (!last) return;
        composer.attachments.remove(last.id);
        event.preventDefault();
      }) ?? null;
  };
  bind();
  const stopWatching = client.composer.subscribe(bind);

  return () => {
    stopWatching();
    releaseKeys?.();
    void removeRenderer();
  };
}
