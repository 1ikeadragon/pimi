import { useEffect } from "react";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { buildOpenProjectRoute } from "@/utils/host-routes";

// Target of `pimi://pair/#offer=...` deep links. The router drops the URL fragment, so the offer
// is read from the raw link. Importing shows the Connect confirmation, then lands on open-project.
export default function PairRoute() {
  const router = useRouter();
  const url = Linking.useURL();

  useEffect(() => {
    const webHref =
      Platform.OS === "web" && typeof window !== "undefined" ? window.location.href : null;
    const link = url ?? webHref;
    if (!link) return;
    if (!link.includes("#offer=") && !link.includes("#connect=")) {
      router.replace("/");
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const result = await getHostRuntimeStore().importConnectionLink(link, "openProject");
        if (!cancelled) {
          router.replace(result.status === "connected" ? buildOpenProjectRoute() : "/");
        }
      } catch (error) {
        console.warn("[PairRoute] Pairing link failed", error);
        if (!cancelled) router.replace("/");
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [url, router]);

  return null;
}
