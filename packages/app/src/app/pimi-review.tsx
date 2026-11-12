// Pimi. Apache-2.0.
import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { parseReviewSource } from "@/navigation/pimi-review";
import { ReviewScreen } from "@/review-screen";
import { useUsageHostId } from "@/usage/hosts";

export default function PimiReviewRoute() {
  const params = useLocalSearchParams();
  const source = useMemo(() => parseReviewSource(params), [params]);
  const defaultServerId = useUsageHostId();
  const requestedServerId = typeof params.serverId === "string" ? params.serverId : null;
  return <ReviewScreen source={source} inboxServerId={requestedServerId ?? defaultServerId} />;
}
