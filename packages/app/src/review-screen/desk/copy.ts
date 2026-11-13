// Pimi. Apache-2.0.
import { useMemo } from "react";
import { useTranslation } from "@/i18n/use-translation";

/** The desk's strings, translated. Read through the hook so a language change re-renders. */
export function useDeskCopy() {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      loadingFiles: t("reviewScreen.desk.loadingFiles"),
      loadingPatch: t("reviewScreen.desk.loadingPatch"),
      loadError: t("reviewScreen.desk.loadError"),
      retry: t("reviewScreen.desk.retry"),
      files: t("reviewScreen.desk.files"),
      noFiles: t("reviewScreen.desk.noFiles"),
      checkoutUnsupported: t("reviewScreen.desk.checkoutUnsupported"),
      filterPlaceholder: t("reviewScreen.desk.filterPlaceholder"),
      filterClear: t("reviewScreen.desk.filterClear"),
      unviewedOnly: t("reviewScreen.desk.unviewedOnly"),
      withThreads: t("reviewScreen.desk.withThreads"),
      viewed: (done: number, total: number) => t("reviewScreen.desk.viewed", { done, total }),
      markViewed: t("reviewScreen.desk.markViewed"),
      markUnviewed: t("reviewScreen.desk.markUnviewed"),
      singleFileNote: (files: number) => t("reviewScreen.desk.singleFileNote", { count: files }),
      showAll: t("reviewScreen.desk.showAll"),
      showSingle: t("reviewScreen.desk.showSingle"),
      previous: t("reviewScreen.desk.previous"),
      next: t("reviewScreen.desk.next"),
      askInChat: t("reviewScreen.desk.askInChat"),
      annotations: (count: number) => t("reviewScreen.desk.annotations", { count }),
      noWorkspace: (repo: string) => t("reviewScreen.desk.noWorkspace", { repo }),
      askUnavailable: t("reviewScreen.desk.askUnavailable"),
      detached: (count: number) => t("reviewScreen.desk.detached", { count }),
      detachedNoLine: t("reviewScreen.desk.detachedNoLine"),
      detachedOutside: t("reviewScreen.desk.detachedOutside"),
      detachedHidden: t("reviewScreen.desk.detachedHidden"),
      threadsFailed: t("reviewScreen.desk.threadsFailed"),
      patchFailed: t("reviewScreen.desk.patchFailed"),
    }),
    [t],
  );
}
