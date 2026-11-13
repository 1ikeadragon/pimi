import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as QRCode from "qrcode";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import {
  PimiLocalPairingStatus,
  type PimiLocalPairingRequest,
} from "@pimi/protocol/connection-offer";
import { SettingsSelect } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { getDesktopHost } from "@/desktop/host";
import { PairingOffer } from "@/desktop/components/pair-device-section";

const STATUS_KEY = ["desktop-local-pairing"] as const;

async function request(input: PimiLocalPairingRequest): Promise<PimiLocalPairingStatus> {
  const invoke = getDesktopHost()?.invoke;
  if (!invoke) throw new Error("Wi-Fi pairing is only available in Pimi Desktop.");
  try {
    return PimiLocalPairingStatus.parse(await invoke("desktop_local_pairing", input));
  } catch (error) {
    // Electron prefixes a main-process throw with "Error invoking remote method '<channel>': Error: ".
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""), {
      cause: error,
    });
  }
}

export function LocalPairingSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<string>();
  const status = useFetchQuery({
    queryKey: STATUS_KEY,
    queryFn: () => request({ action: "status" }),
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const change = useMutation({
    mutationFn: request,
    gcTime: 0,
    onSuccess: (value) => queryClient.setQueryData(STATUS_KEY, value),
  });
  const active = status.data?.active;
  const addresses = status.data?.addresses ?? [];
  const address =
    addresses.find((item) => item.address === selection)?.address ?? addresses[0]?.address;
  const addressOptions = addresses.map(({ address: value, name }) => ({
    value,
    label: `${name} · ${value}`,
  }));
  const error = change.error ?? status.error;
  const { refetch } = status;
  const { mutate } = change;
  const retry = useCallback(() => void refetch(), [refetch]);
  const disable = useCallback(() => mutate({ action: "disable" }), [mutate]);
  const enable = useCallback(() => {
    if (address) mutate({ action: "enable", address });
  }, [address, mutate]);
  const canConfigure = status.isSuccess && !active;

  return (
    <View style={styles.body}>
      <Text style={styles.hint}>{t("pairing.local.description")}</Text>
      {error ? <Alert size="sm" variant="error" description={error.message} /> : null}
      {status.isPending ? (
        <Text style={styles.hint}>{t("pairing.device.loadingOffer")}</Text>
      ) : null}
      {status.isError ? (
        <Button size="sm" variant="outline" onPress={retry}>
          {t("pairing.device.retry")}
        </Button>
      ) : null}
      {active ? (
        <>
          <LocalPairingOffer key={active.url} url={active.url} />
          {active.needsPassword ? (
            <Text style={styles.hint}>{t("pairing.local.password")}</Text>
          ) : null}
          <Text style={styles.hint}>{t("pairing.local.sharing", { address: active.address })}</Text>
          <Button size="sm" variant="outline" disabled={change.isPending} onPress={disable}>
            {t("pairing.local.disable")}
          </Button>
        </>
      ) : null}
      {canConfigure && address ? (
        <>
          {addressOptions.length > 1 ? (
            <SettingsSelect
              label={t("pairing.local.interface")}
              value={address}
              options={addressOptions}
              onValueChange={setSelection}
              disabled={change.isPending}
            />
          ) : null}
          <Button disabled={change.isPending || status.isFetching} onPress={enable}>
            {t("pairing.local.enable")}
          </Button>
        </>
      ) : null}
      {canConfigure && !address ? (
        <>
          <Text style={styles.hint}>{t("pairing.local.noNetwork")}</Text>
          <Button size="sm" variant="outline" onPress={retry}>
            {t("pairing.device.retry")}
          </Button>
        </>
      ) : null}
    </View>
  );
}

function LocalPairingOffer({ url }: { url: string }) {
  const { t } = useTranslation();
  const qr = useFetchQuery({
    queryKey: ["desktop-local-pairing-qr", url],
    queryFn: () => QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1 }),
    dataShape: "value",
    staleTimeMs: 60_000,
    gcTime: 0,
    retry: false,
  });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(url).then(
      (copied) => setCopyState(copied ? "copied" : "error"),
      () => setCopyState("error"),
    );
  }, [url]);

  return (
    <>
      <PairingOffer
        url={url}
        qrSvg={qr.data ?? null}
        qrError={qr.isError}
        copied={copyState === "copied"}
        onCopy={copy}
      />
      {copyState === "error" ? (
        <Alert size="sm" variant="error" description={t("pairing.local.copyFailed")} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3], alignItems: "stretch" },
  hint: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
