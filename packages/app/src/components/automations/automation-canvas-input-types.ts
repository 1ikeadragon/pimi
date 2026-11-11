import type { AutomationEdgeBranch } from "@pimi/protocol/automation/types";
import type { Point } from "@/automations/automation-editor-layout";

export interface CanvasDragLine {
  from: Point;
  to: Point;
}

export interface CanvasDragConnectInput {
  /** The canvas's own width, to turn screen pixels into canvas pixels at any zoom. */
  canvasWidth: number;
  /** Where a handle sits on the canvas. */
  handleOrigin: (nodeId: string, branch: AutomationEdgeBranch | undefined) => Point | null;
  onDrag: (line: CanvasDragLine | null) => void;
  onConnect: (from: string, to: string, branch: AutomationEdgeBranch | undefined) => void;
}
