import type { ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import type { SubagentStatusBucket } from "./status";

/**
 * A child's state as a dot, the same in the delegation card and the sidebar lineage. Colors come
 * from the one bucket-to-color map; a finished child holds the slot with the muted idle dot an
 * idle workspace row uses, so finished never reads as success next to a green "ready" row.
 */
export function SubagentStatusDot({
  bucket,
  testID,
}: {
  bucket: SubagentStatusBucket | "inactive";
  testID?: string;
}): ReactElement {
  return <View style={dotStyleFor(bucket)} testID={testID} />;
}

const dotBase = {
  width: STATUS_INDICATOR_FILLED_DOT_SIZE,
  height: STATUS_INDICATOR_FILLED_DOT_SIZE,
  borderRadius: 999,
  flexShrink: 0,
} as const;

const styles = StyleSheet.create((theme) => ({
  needsInput: {
    ...dotBase,
    backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
  },
  failed: {
    ...dotBase,
    backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
  },
  running: {
    ...dotBase,
    backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
  },
  idle: {
    ...dotBase,
    backgroundColor: theme.colors.foregroundExtraMuted,
    opacity: 0.3,
  },
}));

function dotStyleFor(bucket: SubagentStatusBucket | "inactive") {
  switch (bucket) {
    case "needs_input":
      return styles.needsInput;
    case "failed":
      return styles.failed;
    case "running":
      return styles.running;
    case "done":
    case "inactive":
      return styles.idle;
  }
}
