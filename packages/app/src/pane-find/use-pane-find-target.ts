import { useId } from "react";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";

/**
 * What a pane's content offers to the Find keys. Every method is optional except `open`; a missing
 * method leaves its key unhandled. A method returns `false` when it did nothing (Find is closed, so
 * there is no next match), which also leaves the key unhandled for the platform.
 */
export interface PaneFindTarget {
  open(): boolean | void;
  next?(): boolean | void;
  previous?(): boolean | void;
  openReplace?(): boolean | void;
  toggleCase?(): boolean | void;
  toggleWord?(): boolean | void;
  toggleRegex?(): boolean | void;
}

const PANE_FIND_ACTIONS = [
  "pane.find",
  "pane.find.next",
  "pane.find.previous",
  "pane.replace",
  "pane.find.toggle-case",
  "pane.find.toggle-word",
  "pane.find.toggle-regex",
] as const;

function runTarget(target: PaneFindTarget, action: KeyboardActionDefinition): boolean {
  switch (action.id) {
    case "pane.find":
      return target.open() !== false;
    case "pane.find.next":
      return target.next ? target.next() !== false : false;
    case "pane.find.previous":
      return target.previous ? target.previous() !== false : false;
    case "pane.replace":
      return target.openReplace ? target.openReplace() !== false : false;
    case "pane.find.toggle-case":
      return target.toggleCase ? target.toggleCase() !== false : false;
    case "pane.find.toggle-word":
      return target.toggleWord ? target.toggleWord() !== false : false;
    case "pane.find.toggle-regex":
      return target.toggleRegex ? target.toggleRegex() !== false : false;
    default:
      return false;
  }
}

/**
 * Registers a pane's Find with the shortcut table. Pass `enabled` only while the pane is the one the
 * user is working in (focused, visible); the table then routes Cmd/Ctrl+F, Cmd+G, F3, Replace and the
 * option toggles to it. A pane with no registered target leaves the key to the platform.
 */
export function usePaneFindTarget(target: PaneFindTarget, enabled: boolean) {
  const handlerId = `pane-find:${useId()}`;
  useKeyboardActionHandler({
    handlerId,
    actions: PANE_FIND_ACTIONS,
    enabled,
    priority: 0,
    handle: (action) => runTarget(target, action),
  });
}
