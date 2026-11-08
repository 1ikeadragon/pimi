import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useHarnessUpdates } from "@/hooks/use-harness-updates";
import { useToast } from "@/contexts/toast-api-context";

export function HarnessUpdateNotice({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data, enabled } = useHarnessUpdates(serverId);
  const notified = useRef(new Map<string, string>());
  useEffect(() => {
    if (!enabled || !data) return;
    const updates = data.updates.filter(
      ({ provider, latestVersion, status }) =>
        latestVersion &&
        status === "update_available" &&
        notified.current.get(provider) !== latestVersion,
    );
    if (updates.length === 0) return;
    for (const { provider, latestVersion } of updates) {
      if (latestVersion) notified.current.set(provider, latestVersion);
    }
    toast.show(
      t("harnessUpdates.notice", { providers: updates.map(({ label }) => label).join(", ") }),
      {
        variant: "info",
        durationMs: 8_000,
        testID: "provider-harness-update-notice",
      },
    );
  }, [data, enabled, t, toast]);
  return null;
}
