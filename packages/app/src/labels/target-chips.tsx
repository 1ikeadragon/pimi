import type { ReactElement } from "react";
import type { LabelTarget } from "@pimi/protocol/labels";
import { LabelChipList } from "./chip";
import { LabelDots as LabelDotList } from "./swatch";
import { useTargetLabels } from "./store";

/** The chips of whatever labels one target carries. Renders nothing when it carries none. */
export function LabelChips({
  serverId,
  target,
  wrap = false,
}: {
  serverId: string;
  target: LabelTarget | null;
  wrap?: boolean;
}): ReactElement | null {
  return <LabelChipList labels={useTargetLabels(serverId, target)} wrap={wrap} />;
}

/** One dot per label, for rows with no room for names (sibling chats, subagents). */
export function LabelDots({
  serverId,
  target,
}: {
  serverId: string;
  target: LabelTarget | null;
}): ReactElement | null {
  return <LabelDotList labels={useTargetLabels(serverId, target)} />;
}
