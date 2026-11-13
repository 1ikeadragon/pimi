import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useAddHost } from "@/hosts/add-host";
import { useTranslation } from "@/i18n/use-translation";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { buildOpenProjectRoute } from "@/utils/host-routes";

const LINK_WAIT_MS = 5000;
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function isOfferLink(link: string | null | undefined): link is string {
  return Boolean(link && (link.includes("#offer=") || link.includes("#connect=")));
}

// Target of `pimi://pair/#offer=...` deep links. The router drops the URL fragment, so the offer
// is read from the raw link. With the app already running the link can arrive after this screen
// mounts, so every source is watched: the hook URL, the initial URL, the `url` event and the web
// href. Importing shows the Connect confirmation, then lands on open-project. Without a valid link
// after LINK_WAIT_MS the screen offers Add a host and Go home instead of staying blank.
export default function PairRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const hookUrl = Linking.useURL();
  const [eventUrl, setEventUrl] = useState<string | null>(null);
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const importedLinkRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const readInitialUrl = async () => {
      try {
        const url = await Linking.getInitialURL();
        if (!cancelled) setInitialUrl(url);
      } catch {
        // No initial URL is the normal state when the app opened without a link.
      }
    };
    void readInitialUrl();
    const subscription = Linking.addEventListener("url", (event) => setEventUrl(event.url));
    const onHashChange = () => setEventUrl(window.location.href);
    if (Platform.OS === "web") window.addEventListener("hashchange", onHashChange);
    return () => {
      cancelled = true;
      subscription.remove();
      if (Platform.OS === "web") window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const webHref =
    Platform.OS === "web" && typeof window !== "undefined" ? window.location.href : null;
  const link = [eventUrl, hookUrl, initialUrl, webHref].find(isOfferLink) ?? null;

  useEffect(() => {
    if (link) return;
    const timer = setTimeout(() => setTimedOut(true), LINK_WAIT_MS);
    return () => clearTimeout(timer);
  }, [link]);

  useEffect(() => {
    if (!link || importedLinkRef.current === link) return;
    importedLinkRef.current = link;
    let cancelled = false;
    const run = async () => {
      try {
        const result = await getHostRuntimeStore().importConnectionLink(link, "openProject");
        if (cancelled) return;
        if (result.status === "connected") router.replace(buildOpenProjectRoute());
        else router.replace("/");
      } catch (error) {
        console.warn("[PairRoute] Pairing link failed", error);
        if (!cancelled) setFailed(true);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [link, router]);

  const goHome = useCallback(() => router.replace("/"), [router]);
  const handleAdded = useCallback(() => router.replace(buildOpenProjectRoute()), [router]);
  const openAddHost = useAddHost({ onAdded: handleAdded });

  const showError = failed || (!link && timedOut);

  return (
    <View style={styles.container}>
      {showError ? (
        <View style={styles.card}>
          <Alert
            size="sm"
            variant="error"
            title={t("pairing.route.errorTitle")}
            description={t("pairing.route.errorDescription")}
          />
          <View style={styles.actions}>
            <Button variant="outline" style={styles.action} onPress={goHome}>
              {t("pairing.route.goHome")}
            </Button>
            <Button variant="default" style={styles.action} onPress={openAddHost}>
              {t("pairing.route.addHost")}
            </Button>
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
          <Text style={styles.loading}>{t("pairing.route.loading")}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[4],
  },
  card: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[4],
    alignItems: "stretch",
  },
  loading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  actions: { flexDirection: "row", gap: theme.spacing[3] },
  action: { flex: 1 },
}));
