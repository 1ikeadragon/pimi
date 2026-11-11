import type { RefObject } from "react";
import type { View } from "react-native";
import type { CanvasDragConnectInput } from "./automation-canvas-input-types";

export type { CanvasDragConnectInput, CanvasDragLine } from "./automation-canvas-input-types";

/** Native: links are made from the handle's menu or the inspector; there is no drag. */
export function useCanvasDragConnect(
  _root: RefObject<View | null>,
  _input: CanvasDragConnectInput,
): void {}

/** Native has no Delete key; the inspector deletes the step. */
export function useDeleteSelectedStep(_onDelete: (() => void) | null): void {}
