export interface ActivityTextProps {
  verb: string;
  target?: string;
  /** The target is a command or code, set in the mono face at code size. */
  targetMono?: boolean;
  /** The row is hovered or open: the target joins the verb at full foreground. */
  emphasized: boolean;
  /** The call is still running. */
  running: boolean;
  /** Sweep a highlight across the label. False for reduced motion and inactive panels. */
  shimmer: boolean;
}
