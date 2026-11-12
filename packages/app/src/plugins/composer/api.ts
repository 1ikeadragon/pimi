import type {
  PluginAnnotationSource,
  PluginComposer,
  PluginComposerApi,
  PluginComposerAttachment,
  PluginComposerAttachments,
} from "@pimi/plugin/client";
import type { UserComposerAttachment } from "@/attachments/types";
import {
  AnnotationAttachmentSchema,
  type AnnotationAttachment,
  type AnnotationSource,
} from "@/annotations/model";
import { generateMessageId } from "@/types/stream";
import type { InstalledPlugin } from "../types";
import { composerRegistry, type ComposerController, type ComposerRegistry } from "./controller";

function toPluginSource(source: AnnotationSource): PluginAnnotationSource {
  if (source.kind === "file") {
    const { serverId: _serverId, ...rest } = source;
    return rest;
  }
  const { serverId: _serverId, ...rest } = source;
  return rest;
}

function toPluginAttachment(attachment: AnnotationAttachment): PluginComposerAttachment {
  return {
    kind: "annotation",
    id: attachment.id,
    quote: attachment.quote,
    note: attachment.note,
    source: toPluginSource(attachment.source),
  };
}

function isAnnotation(attachment: UserComposerAttachment): attachment is AnnotationAttachment {
  return attachment.kind === "annotation";
}

/** The plugin's view of the draft's attachments, stable until the draft's own array changes. */
function createAttachmentsHandle(
  controller: ComposerController,
  installation: InstalledPlugin,
  track: (release: () => void) => () => void,
): PluginComposerAttachments {
  let cachedFrom: readonly UserComposerAttachment[] | null = null;
  let cached: readonly PluginComposerAttachment[] = [];
  const live = () => {
    if (installation.lifetime.signal.aborted) throw new Error("Plugin has stopped");
  };
  return {
    list() {
      const source = controller.surface.getAttachments();
      if (source !== cachedFrom) {
        cachedFrom = source;
        cached = source.filter(isAnnotation).map(toPluginAttachment);
      }
      return cached;
    },
    add(input) {
      live();
      if (input.kind !== "annotation")
        throw new Error(`Unsupported attachment kind: ${input.kind}`);
      const source: AnnotationSource = { ...input.source, serverId: installation.serverId };
      const attachment = AnnotationAttachmentSchema.parse({
        kind: "annotation",
        id: generateMessageId(),
        source,
        quote: input.quote,
        note: input.note ?? "",
      });
      controller.surface.updateAttachments((prev) => [...prev, attachment]);
      return toPluginAttachment(attachment);
    },
    remove(id) {
      live();
      if (!controller.surface.getAttachments().some((a) => isAnnotation(a) && a.id === id)) {
        return false;
      }
      controller.surface.updateAttachments((prev) =>
        prev.filter((a) => !(isAnnotation(a) && a.id === id)),
      );
      return true;
    },
    update(id, patch) {
      live();
      const current = controller.surface
        .getAttachments()
        .find((a) => isAnnotation(a) && a.id === id);
      if (!current || !isAnnotation(current)) return false;
      // Parse the merge now so an over-long note throws to the plugin, not inside the draft store.
      AnnotationAttachmentSchema.parse({
        ...current,
        ...(patch.quote !== undefined ? { quote: patch.quote } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
      });
      controller.surface.updateAttachments((prev) =>
        prev.map((a) =>
          isAnnotation(a) && a.id === id
            ? {
                ...a,
                ...(patch.quote !== undefined ? { quote: patch.quote } : {}),
                ...(patch.note !== undefined ? { note: patch.note } : {}),
              }
            : a,
        ),
      );
      return true;
    },
    subscribe(listener) {
      return track(controller.subscribeAttachments(listener));
    },
  };
}

function createComposerHandle(
  controller: ComposerController,
  installation: InstalledPlugin,
  track: (release: () => void) => () => void,
): PluginComposer {
  const live = () => {
    if (installation.lifetime.signal.aborted) throw new Error("Plugin has stopped");
  };
  const clamp = (selection: { start: number; end: number }) => {
    const length = controller.surface.getText().length;
    const start = Math.max(0, Math.min(selection.start, length));
    const end = Math.max(start, Math.min(selection.end, length));
    return { start, end };
  };
  return {
    get kind() {
      return controller.identity.kind;
    },
    get workspaceId() {
      return controller.identity.workspaceId;
    },
    get agentId() {
      return controller.identity.agentId;
    },
    getText: () => controller.surface.getText(),
    getSelection: () => controller.surface.getSelection(),
    replaceText(text, selection) {
      live();
      controller.surface.replaceText(text, selection ? clamp(selection) : undefined);
    },
    insertText(text) {
      live();
      const current = controller.surface.getText();
      const { start, end } = controller.surface.getSelection();
      const caret = start + text.length;
      controller.surface.replaceText(current.slice(0, start) + text + current.slice(end), {
        start: caret,
        end: caret,
      });
    },
    setSelection(selection) {
      live();
      controller.surface.setSelection(clamp(selection));
    },
    focus() {
      live();
      controller.surface.focus();
    },
    subscribe: (listener) => track(controller.subscribeInput(listener)),
    onKeyDown: (handler) => track(controller.addKeyHandler(handler)),
    attachments: createAttachmentsHandle(controller, installation, track),
  };
}

export interface PluginComposerBridge {
  api: PluginComposerApi;
  /** The plugin's handle for a composer, or null when the composer belongs to another host. */
  handleFor(controller: ComposerController): PluginComposer | null;
}

// Keyed by the lifetime: the registry republishes installations as copies that share it.
const bridges = new WeakMap<AbortController, PluginComposerBridge>();

/**
 * The plugin's composer API. Handles are cached per composer so `active()` is stable between
 * changes, and every subscription is released with the installation.
 */
export function getPluginComposerBridge(
  installation: InstalledPlugin,
  registry: ComposerRegistry = composerRegistry,
): PluginComposerBridge {
  const existing = bridges.get(installation.lifetime);
  if (existing) return existing;
  const releases = new Set<() => void>();
  const track = (release: () => void) => {
    if (installation.lifetime.signal.aborted) {
      release();
      return () => {};
    }
    const wrapped = () => {
      if (!releases.delete(wrapped)) return;
      release();
    };
    releases.add(wrapped);
    return wrapped;
  };
  installation.lifetime.signal.addEventListener(
    "abort",
    () => {
      for (const release of Array.from(releases)) release();
    },
    { once: true },
  );
  const handles = new WeakMap<ComposerController, PluginComposer>();
  const handleFor = (controller: ComposerController) => {
    if (controller.identity.serverId !== installation.serverId) return null;
    let handle = handles.get(controller);
    if (!handle) {
      handle = createComposerHandle(controller, installation, track);
      handles.set(controller, handle);
    }
    return handle;
  };
  const bridge: PluginComposerBridge = {
    api: {
      active() {
        const controller = registry.getActive();
        return controller ? handleFor(controller) : null;
      },
      subscribe: (listener) => track(registry.subscribe(listener)),
    },
    handleFor,
  };
  bridges.set(installation.lifetime, bridge);
  return bridge;
}
