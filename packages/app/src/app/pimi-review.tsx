import { overridable } from "@/extension-points";
// Pimi. PolyForm-Noncommercial-1.0.0.
import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { parseReviewFocus, parseReviewSource } from "@/navigation/pimi-review";
import { ReviewScreen } from "@/review-screen";
import { useUsageHostId } from "@/usage/hosts";

const Review = overridable("screen.review", ReviewScreen, {
  toPlugin: ({ serverId }) => ({ serverId }),
  merge: (core, patch) => ({ ...core, serverId: patch.serverId ?? core.serverId }),
});

export default function PimiReviewRoute() {
  const params = useLocalSearchParams();
  const source = useMemo(() => parseReviewSource(params), [params]);
  const focus = useMemo(() => parseReviewFocus(params), [params]);
  const defaultServerId = useUsageHostId();
  const requestedServerId = typeof params.serverId === "string" ? params.serverId : null;
  return <Review source={source} focus={focus} serverId={requestedServerId ?? defaultServerId} />;
}
