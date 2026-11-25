import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { LiveElapsed } from "@/components/message";
import { Button } from "@/components/ui/button";
import type { MenuPageDefinition } from "@/components/ui/menu";
import { ShellTerminal } from "@/tool-calls/shell/terminal";
import type { PimiAgentBackgroundWorkItem } from "@pimi/client";
import { createHostBackgroundWorkModel } from "./host";
import { useBackgroundShellOutput } from "./output";
import { backgroundWorkText } from "./presentation";
export { createHostBackgroundWorkModel } from "./host";

function kindKey(kind: string): "shell" | "monitor" | "other" {
  if (kind === "shell" || kind === "monitor") return kind;
  return "other";
}

function outputPageId(item: PimiAgentBackgroundWorkItem): string {
  return `background-output:${item.id}`;
}

export function BackgroundWorkTrack({
  serverId,
  agentId,
  model,
  count,
}: {
  serverId: string;
  agentId: string;
  model: ReturnType<typeof createHostBackgroundWorkModel>;
  count: number;
}) {
  const { t } = useTranslation();
  const { items, status, stops, viewable } = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );
  const [panelOpen, setPanelOpen] = useState(false);
  const pages = useMemo<MenuPageDefinition[]>(
    () =>
      viewable.map((item) => ({
        id: outputPageId(item),
        title: backgroundWorkText(item, t(`message.backgroundWork.${kindKey(item.kind)}`)).title,
        hoverIntent: false,
        content: <BackgroundOutputPage serverId={serverId} agentId={agentId} item={item} />,
      })),
    [viewable, serverId, agentId, t],
  );
  const missing = Object.values(stops ?? {}).filter(
    (entry) => !items?.some((item) => item.stopToken === entry.item.stopToken),
  );
  const rows = [...(items ?? []), ...missing.map((entry) => entry.item)];
  // An output page stays open after its job ends, so the pill outlives the last job until closed.
  if (count === 0 && rows.length === 0 && !panelOpen) return null;
  const visibleCount = items?.length || count;
  return (
    <ComposerTrackPill
      testID="background-work"
      pages={pages}
      onOpenChange={setPanelOpen}
      panelTitle={t("message.backgroundWork.title")}
      segments={[
        {
          bucket: "running",
          text:
            visibleCount === 1
              ? t("message.backgroundWork.pillOne")
              : t("message.backgroundWork.pillMany", { count: visibleCount }),
        },
      ]}
    >
      {status === "loading" || status === "stale" ? (
        <ComposerTrackRow>
          <Text style={styles.facts}>{t("message.backgroundWork.waiting")}</Text>
        </ComposerTrackRow>
      ) : null}
      {status === "error" ? (
        <>
          <ComposerTrackRow>
            <Text style={styles.facts}>{t("message.backgroundWork.error")}</Text>
          </ComposerTrackRow>
          <ComposerTrackRow
            onPress={model.retry}
            closeOnSelect={false}
            accessibilityLabel={t("message.backgroundWork.retry")}
          >
            <Text style={styles.title}>{t("message.backgroundWork.retry")}</Text>
          </ComposerTrackRow>
        </>
      ) : null}
      {rows.map((item) => (
        <BackgroundWorkRow
          key={item.stopToken ?? item.id}
          item={item}
          model={model}
          live={Boolean(items?.some((entry) => entry.stopToken === item.stopToken))}
          ready={status === "ready"}
          stopStatus={stops?.[item.stopToken ?? ""]?.status}
        />
      ))}
    </ComposerTrackPill>
  );
}

function BackgroundWorkRow({
  item,
  model,
  live,
  ready,
  stopStatus,
}: {
  item: PimiAgentBackgroundWorkItem;
  model: ReturnType<typeof createHostBackgroundWorkModel>;
  live: boolean;
  ready: boolean;
  stopStatus?: "pending" | "error";
}) {
  const { t } = useTranslation();
  const kind = t(`message.backgroundWork.${kindKey(item.kind)}`);
  const stop = useCallback(() => {
    void model.stopItem(item);
  }, [model, item]);
  const dismiss = useCallback(
    () => model.dismissStop(item.stopToken ?? ""),
    [model, item.stopToken],
  );
  let detail = t("message.backgroundWork.notRunning");
  if (stopStatus === "pending") detail = t("message.backgroundWork.stopping");
  const { title, command } = backgroundWorkText(item, kind);
  const action = item.canStop && ready && live;
  const opensPage = item.hasOutput ? outputPageId(item) : undefined;
  const label =
    stopStatus === "pending"
      ? t("message.backgroundWork.stopping")
      : t("message.backgroundWork.stop");
  return (
    <ComposerTrackRow opensPage={opensPage} testID={`background-work-row-${item.id}`}>
      <View style={styles.row}>
        <Text style={styles.title}>{title}</Text>
        {command ? <Text style={styles.facts}>{command}</Text> : null}
        <Text style={styles.facts}>
          {kind} ·{" "}
          {live ? (
            <LiveElapsed startedAt={new Date(item.startedAt)} active style={styles.facts} />
          ) : (
            detail
          )}
        </Text>
        {stopStatus === "error" ? (
          <Text style={styles.facts}>{t("message.backgroundWork.stopError")}</Text>
        ) : null}
      </View>
      {action ? (
        <Button
          variant="ghost"
          size="sm"
          accessibilityLabel={`${t("message.backgroundWork.stop")} ${title}`}
          disabled={stopStatus === "pending"}
          onPress={stop}
        >
          {label}
        </Button>
      ) : null}
      {!live && stopStatus === "error" ? (
        <Button variant="ghost" size="sm" onPress={dismiss}>
          {t("message.backgroundWork.dismiss")}
        </Button>
      ) : null}
    </ComposerTrackRow>
  );
}

const OUTPUT_LOADING_DELAY_MS = 150;

/** The page a row opens: the job's output in a read-only terminal, tailed while it runs. */
function BackgroundOutputPage({
  serverId,
  agentId,
  item,
}: {
  serverId: string;
  agentId: string;
  item: PimiAgentBackgroundWorkItem;
}) {
  const { t } = useTranslation();
  const { status, output, outputOffset, running, retry } = useBackgroundShellOutput({
    serverId,
    agentId,
    itemId: item.id,
  });
  const [loadingShown, setLoadingShown] = useState(false);
  useEffect(() => {
    if (status !== "loading") {
      setLoadingShown(false);
      return undefined;
    }
    const timer = setTimeout(() => setLoadingShown(true), OUTPUT_LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);
  const kind = t(`message.backgroundWork.${kindKey(item.kind)}`);
  const { title, command } = backgroundWorkText(item, kind);
  return (
    <View style={styles.page} testID="background-work-output">
      <View style={styles.terminal}>
        <ShellTerminal
          streamKey={`background:${item.id}`}
          command={command ?? title}
          output={output}
          outputOffset={outputOffset}
          state={running ? "running" : "completed"}
          fill
          maxHeight={undefined}
        />
      </View>
      {status === "error" ? (
        <View style={styles.pageFooter}>
          <Text style={styles.facts}>{t("message.backgroundWork.outputError")}</Text>
          <Button variant="ghost" size="sm" onPress={retry} testID="background-work-output-retry">
            {t("message.backgroundWork.retry")}
          </Button>
        </View>
      ) : null}
      {status === "loading" && loadingShown ? (
        <Text style={styles.facts}>{t("message.backgroundWork.loadingOutput")}</Text>
      ) : null}
      {status === "ready" && !running ? (
        <Text style={styles.facts}>{t("message.backgroundWork.notRunning")}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { gap: theme.spacing[2], padding: theme.spacing[2] },
  terminal: { height: 300 },
  pageFooter: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  row: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  title: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  facts: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
