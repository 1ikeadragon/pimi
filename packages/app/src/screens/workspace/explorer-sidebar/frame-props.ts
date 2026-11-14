import type { ReactNode } from "react";
export interface ExplorerFrameProps {
  children: ReactNode;
  presentation: "overlay" | "dock";
  persistenceKey: string;
  containerWidth: number;
  isOpen: boolean;
  isWorkspaceActive: boolean;
  side?: "left" | "right";
  /** Fill while the panel floats over the workspace. Docked, its content paints its own surface. */
  surfaceColor?: string;
}
