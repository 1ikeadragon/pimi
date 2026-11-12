import type { PluginComposerKeyEvent } from "@pimi/plugin/client";
import type { UserComposerAttachment } from "@/attachments/types";

export interface ComposerSelection {
  start: number;
  end: number;
}

export type AttachmentUpdater = (prev: UserComposerAttachment[]) => UserComposerAttachment[];

/** What a mounted composer lends plugins. Replaced on every render with that render's closures. */
export interface ComposerSurface {
  getText(): string;
  getSelection(): ComposerSelection;
  replaceText(text: string, selection?: ComposerSelection): void;
  setSelection(selection: ComposerSelection): void;
  focus(): void;
  getAttachments(): readonly UserComposerAttachment[];
  updateAttachments(updater: AttachmentUpdater): void;
}

export interface ComposerIdentity {
  serverId: string;
  workspaceId: string | null;
  agentId: string | null;
  kind: "agent" | "draft";
}

/**
 * One mounted chat composer, as plugins see it. The composer owns the draft; this object forwards
 * to its latest render and fans change notifications out to plugin listeners.
 */
export class ComposerController {
  private readonly inputListeners = new Set<() => void>();
  private readonly attachmentListeners = new Set<() => void>();
  private readonly keyHandlers = new Set<(event: PluginComposerKeyEvent) => void>();

  constructor(
    public identity: ComposerIdentity,
    public surface: ComposerSurface,
  ) {}

  subscribeInput = (listener: () => void): (() => void) => {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  };

  subscribeAttachments = (listener: () => void): (() => void) => {
    this.attachmentListeners.add(listener);
    return () => this.attachmentListeners.delete(listener);
  };

  addKeyHandler(handler: (event: PluginComposerKeyEvent) => void): () => void {
    this.keyHandlers.add(handler);
    return () => this.keyHandlers.delete(handler);
  }

  notifyInput(): void {
    notify(this.inputListeners);
  }

  notifyAttachments(): void {
    notify(this.attachmentListeners);
  }

  /** Runs plugin key handlers; true when one consumed the key. */
  handleKey(input: {
    key: string;
    hasModifier: boolean;
    text: string;
    selection: ComposerSelection;
  }): boolean {
    if (this.keyHandlers.size === 0) return false;
    let consumed = false;
    const event: PluginComposerKeyEvent = {
      ...input,
      preventDefault: () => {
        consumed = true;
      },
    };
    for (const handler of Array.from(this.keyHandlers)) {
      try {
        handler(event);
      } catch (error) {
        console.warn("[Plugins] Composer key handler failed", error);
      }
    }
    return consumed;
  }
}

function notify(listeners: Set<() => void>): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.warn("[Plugins] Composer listener failed", error);
    }
  }
}

/** Mounted chat composers. The active one is the one the user used last that is still mounted. */
export class ComposerRegistry {
  private readonly mounted = new Set<ComposerController>();
  private lastActive: ComposerController | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mount(controller: ComposerController): () => void {
    this.mounted.add(controller);
    return () => {
      this.mounted.delete(controller);
      if (this.lastActive === controller) {
        this.lastActive = null;
        notify(this.listeners);
      }
    };
  }

  markActive(controller: ComposerController): void {
    if (this.lastActive === controller || !this.mounted.has(controller)) return;
    this.lastActive = controller;
    notify(this.listeners);
  }

  getActive(): ComposerController | null {
    return this.lastActive;
  }
}

export const composerRegistry = new ComposerRegistry();
