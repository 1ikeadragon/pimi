import { useEffect, useRef } from "react";
import type { UserComposerAttachment } from "@/attachments/types";
import type { ComposerTextSource } from "@/composer/text-source";
import {
  ComposerController,
  composerRegistry,
  type ComposerIdentity,
  type ComposerSurface,
} from "./controller";

/**
 * Lends a mounted chat composer to plugins. `controller.surface` follows each render, so plugin
 * calls act on current props; the effects only announce changes and the active composer.
 */
export function usePluginComposerBinding(input: {
  enabled: boolean;
  isActive: boolean;
  identity: ComposerIdentity;
  surface: ComposerSurface;
  textSource: ComposerTextSource;
  attachments: readonly UserComposerAttachment[];
}): ComposerController {
  const { enabled, isActive, identity, surface, textSource, attachments } = input;
  const ref = useRef<ComposerController | null>(null);
  if (!ref.current) ref.current = new ComposerController(identity, surface);
  const controller = ref.current;
  controller.identity = identity;
  controller.surface = surface;

  useEffect(() => {
    if (!enabled) return undefined;
    return composerRegistry.mount(controller);
  }, [controller, enabled]);

  useEffect(() => {
    if (enabled && isActive) composerRegistry.markActive(controller);
  }, [controller, enabled, isActive]);

  useEffect(() => textSource.subscribe(() => controller.notifyInput()), [controller, textSource]);

  useEffect(() => {
    controller.notifyAttachments();
  }, [attachments, controller]);

  return controller;
}
