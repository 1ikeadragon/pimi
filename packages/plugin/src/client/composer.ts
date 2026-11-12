import type { ComponentType } from "react";
import type { PluginHostProps } from "./contracts.js";

/** Where an annotated quote came from. The plugin's host is implied, so no server ID. */
export type PluginAnnotationSource =
  | {
      readonly kind: "file";
      readonly workspaceId: string;
      readonly path: string;
      /** 1-based. `endColumn` is one past the last selected character. */
      readonly startLine: number;
      readonly startColumn: number;
      readonly endLine: number;
      readonly endColumn: number;
    }
  | {
      readonly kind: "chat";
      readonly agentId: string;
      readonly messageId: string;
      readonly role: "user" | "assistant";
    };

/** A quote the user annotated, waiting in a composer draft. */
export interface PluginAnnotationAttachment {
  readonly kind: "annotation";
  readonly id: string;
  readonly quote: string;
  /** The user's note; empty until they write one. */
  readonly note: string;
  readonly source: PluginAnnotationSource;
}

/**
 * A draft attachment a plugin can see. Only annotations today; images, files, forge items, and
 * workspace context stay private to Pimi. Switch on `kind` so new kinds do not break you.
 */
export type PluginComposerAttachment = PluginAnnotationAttachment;

export type PluginComposerAttachmentKind = PluginComposerAttachment["kind"];

export interface PluginAnnotationAttachmentInput {
  readonly kind: "annotation";
  readonly quote: string;
  readonly note?: string;
  readonly source: PluginAnnotationSource;
}

export type PluginComposerAttachmentInput = PluginAnnotationAttachmentInput;

/** Fields `update` can change. `source` and `id` never change. */
export interface PluginAnnotationAttachmentPatch {
  readonly quote?: string;
  readonly note?: string;
}

export interface PluginComposerSelection {
  /** UTF-16 offsets into the draft text. `start === end` is a caret. */
  readonly start: number;
  readonly end: number;
}

/** A key pressed in the composer's text field. Web and desktop only; native has no such event. */
export interface PluginComposerKeyEvent {
  /** DOM `KeyboardEvent.key`: `"Backspace"`, `"Enter"`, `"a"`. */
  readonly key: string;
  /** Shift, Alt, Ctrl, or Meta was held. */
  readonly hasModifier: boolean;
  /** The text and selection at the moment of the press, before the key takes effect. */
  readonly text: string;
  readonly selection: PluginComposerSelection;
  /** Stops the key's default effect and Pimi's own handling of it. */
  preventDefault(): void;
}

export interface PluginComposerAttachments {
  /**
   * The draft's annotations in order. The array identity changes only when its contents do, so
   * it works as a `useSyncExternalStore` snapshot.
   */
  list(): readonly PluginComposerAttachment[];
  /** Appends an attachment and returns it with its new ID. Throws when the input is invalid. */
  add(input: PluginComposerAttachmentInput): PluginComposerAttachment;
  /** Returns false when no attachment has the ID. Remaining attachments keep their order. */
  remove(id: string): boolean;
  /** Merges the patch into the attachment. Returns false when no attachment has the ID. */
  update(id: string, patch: PluginAnnotationAttachmentPatch): boolean;
  /** Calls `listener` after the list changes, whoever changed it. */
  subscribe(listener: () => void): () => void;
}

/** One mounted composer: an agent's chat or a new-agent draft. */
export interface PluginComposer {
  readonly kind: "agent" | "draft";
  readonly workspaceId: string | null;
  /** Null for a new-agent draft, which has no agent yet. */
  readonly agentId: string | null;
  getText(): string;
  getSelection(): PluginComposerSelection;
  /** Replaces the whole draft text. The caret goes to the end unless `selection` is given. */
  replaceText(text: string, selection?: PluginComposerSelection): void;
  /** Replaces the selection, or inserts at the caret, and leaves the caret after the new text. */
  insertText(text: string): void;
  setSelection(selection: PluginComposerSelection): void;
  focus(): void;
  /** Calls `listener` after the text or the selection changes. Read the new values from the handle. */
  subscribe(listener: () => void): () => void;
  /**
   * Sees keys before Pimi's default handling, after an open autocomplete has claimed its own.
   * Call `event.preventDefault()` to consume one. Web and desktop only.
   */
  onKeyDown(handler: (event: PluginComposerKeyEvent) => void): () => void;
  readonly attachments: PluginComposerAttachments;
}

export interface PluginComposerApi {
  /**
   * The composer the user last used on this plugin's host, while it is mounted; null when none is.
   * A plugin sees composers of its own host only.
   */
  active(): PluginComposer | null;
  /** Calls `listener` when `active()` returns a different composer. */
  subscribe(listener: () => void): () => void;
}

export interface PluginAttachmentRendererProps<
  Attachment extends PluginComposerAttachment = PluginComposerAttachment,
> extends PluginHostProps {
  attachment: Attachment;
  /** Position among the draft's attachments. */
  index: number;
  /** The composer holding the attachment, for `remove` and `update`. */
  composer: PluginComposer;
  /** The composer is submitting. Do not offer edits. */
  disabled: boolean;
  /** Takes the user to the annotated source, as the default pill does. Does nothing without one. */
  openSource(): void;
}

export interface PluginAttachmentRendererContribution<
  Kind extends PluginComposerAttachmentKind = PluginComposerAttachmentKind,
> {
  /** The attachment kind to draw. Only `"annotation"` is available. */
  kind: Kind;
  /**
   * Replaces the default pill and its hover card. Pimi falls back to the default when this throws
   * or when the plugin is disabled.
   */
  Component: ComponentType<
    PluginAttachmentRendererProps<Extract<PluginComposerAttachment, { kind: Kind }>>
  >;
}
