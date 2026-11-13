import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Image, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import type { AttackDesktopAction, AttackDesktopTarget } from "@pimi/protocol/attack/types";
import { OctagonX } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import type { DesktopTargetPermissions } from "@/desktop/host";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import { useAttackStore } from "../attack-store";
import { isWindowsTarget } from "../desktop-target-info";
import { useAttackDesktopLog } from "../use-attack-desktop-log";
import {
  hasDesktopTargetBridge,
  useDesktopPermissions,
  useDesktopStill,
  type DesktopPermissionState,
} from "../use-desktop-target";
import type { AttackSubviewProps } from "./types";

const WIDE_WIDTH = 760;
const RING_SIZE = 28;

function clockTime(iso: string): string {
  const date = new Date(iso);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

type Granted = "granted" | "missing";

function accessState(permissions: DesktopTargetPermissions | null): {
  accessibility: Granted;
  screen: Granted;
} {
  if (!permissions || !permissions.supported)
    return { accessibility: "missing", screen: "missing" };
  return {
    accessibility: permissions.accessibility ? "granted" : "missing",
    screen: permissions.screen === "granted" ? "granted" : "missing",
  };
}

export function DesktopSubview({ serverId, run, live }: AttackSubviewProps) {
  const { t } = useTranslation();
  const target = run.desktopTarget;
  const permissionState = useDesktopPermissions();
  if (!target) {
    return (
      <View style={styles.empty} testID="attack-subview-desktop">
        <Text style={styles.emptyText}>{t("attack.subviews.desktop.empty")}</Text>
      </View>
    );
  }
  if (!hasDesktopTargetBridge()) {
    return (
      <View style={styles.empty} testID="attack-subview-desktop">
        <Text style={styles.emptyText}>{t("attack.subviews.desktop.desktopOnly")}</Text>
      </View>
    );
  }
  return (
    <DesktopStage
      runId={run.id}
      target={target}
      running={live && run.status === "running"}
      allowInput={!run.desktopInputStopped && (run.allowDesktopInput || run.disposableTarget)}
      permissionState={permissionState}
      serverId={serverId}
    />
  );
}

function StopInputButton({ serverId, runId }: { serverId: string; runId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onPress = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.attackRunDesktopInputSet({ runId, allow: false });
      useAttackStore.getState().putRun(serverId, result.run);
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [client, runId, serverId]);
  const onStop = useCallback(() => void onPress(), [onPress]);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        leftIcon={OctagonX}
        loading={busy}
        disabled={busy || !client}
        onPress={onStop}
        testID="attack-desktop-stop-input"
      >
        {t("attack.subviews.desktop.stopInput")}
      </Button>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </>
  );
}

function DesktopStage({
  serverId,
  runId,
  target,
  running,
  allowInput,
  permissionState,
}: {
  serverId: string;
  runId: string;
  target: AttackDesktopTarget;
  running: boolean;
  allowInput: boolean;
  permissionState: DesktopPermissionState;
}) {
  const { t } = useTranslation();
  const { permissions, request, openSettings } = permissionState;
  // Windows has no OS permission to grant; the mac rows and settings buttons stay hidden there.
  const windows = isWindowsTarget(target);
  const access = windows
    ? ({ accessibility: "granted", screen: "granted" } as const)
    : accessState(permissions);
  const screenOk = access.screen === "granted";
  const actions = useAttackDesktopLog(runId);
  // Stills are cheap only when someone is looking: mounted, running, and Screen Recording granted.
  const { still, error } = useDesktopStill(runId, target, running && screenOk);
  const [width, setWidth] = useState(1000);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const wide = width >= WIDE_WIDTH;
  const lastPoint = actions.toReversed().find((action) => action.point !== null) ?? null;
  const onGrant = useCallback(() => {
    void request();
  }, [request]);
  const onOpenAccessibility = useCallback(() => openSettings("accessibility"), [openSettings]);
  const onOpenScreen = useCallback(() => openSettings("screen"), [openSettings]);
  const needsGrant = !windows && (access.accessibility === "missing" || !screenOk);

  return (
    <View style={styles.root} onLayout={onLayout} testID="attack-subview-desktop">
      <View style={styles.bar}>
        <Text style={styles.owner} numberOfLines={1} testID="attack-desktop-target">
          {target.appName}
          {target.windowTitle ? ` · "${target.windowTitle}"` : ""}
        </Text>
        {windows && target.win?.framework ? (
          <Badge
            label={t("attack.subviews.desktop.framework")}
            value={target.win.framework}
            ok
            testID="attack-desktop-framework"
          />
        ) : null}
        {windows ? null : (
          <>
            <Badge
              label={t("attack.subviews.desktop.accessibility")}
              value={t(`attack.subviews.desktop.${access.accessibility}`)}
              ok={access.accessibility === "granted"}
              testID="attack-desktop-ax"
            />
            <Badge
              label={t("attack.subviews.desktop.screen")}
              value={t(`attack.subviews.desktop.${access.screen}`)}
              ok={screenOk}
              testID="attack-desktop-screen"
            />
          </>
        )}
        <Badge
          label={t("attack.subviews.desktop.input")}
          value={t(
            allowInput ? "attack.subviews.desktop.inputOn" : "attack.subviews.desktop.inputOff",
          )}
          ok={allowInput}
          testID="attack-desktop-input"
        />
        {allowInput && running ? <StopInputButton serverId={serverId} runId={runId} /> : null}
      </View>
      {needsGrant ? (
        <View style={styles.grant} testID="attack-desktop-grant">
          <Text style={styles.grantText}>{t("attack.subviews.desktop.grantBody")}</Text>
          <View style={styles.grantButtons}>
            <Button
              variant="default"
              size="sm"
              onPress={onGrant}
              testID="attack-desktop-grant-button"
            >
              {t("attack.subviews.desktop.grantAccess")}
            </Button>
            <Button variant="outline" size="sm" onPress={onOpenAccessibility}>
              {t("attack.subviews.desktop.openAccessibility")}
            </Button>
            <Button variant="outline" size="sm" onPress={onOpenScreen}>
              {t("attack.subviews.desktop.openScreen")}
            </Button>
          </View>
        </View>
      ) : null}
      <View style={[styles.body, wide ? styles.bodyWide : styles.bodyNarrow]}>
        <View style={styles.stage}>
          <WindowStill still={still} lastPoint={lastPoint} />
          {error ? (
            <Text style={styles.error} testID="attack-desktop-error">
              {error}
            </Text>
          ) : null}
          <Text style={styles.note}>{t("attack.subviews.desktop.readOnlyNote")}</Text>
        </View>
        <View style={wide ? styles.logWide : styles.logNarrow}>
          <Text style={styles.logTitle}>{t("attack.subviews.desktop.actionLog")}</Text>
          <ScrollView testID="attack-desktop-log">
            {actions.length === 0 ? (
              <Text style={styles.logEmpty}>{t("attack.subviews.desktop.noActions")}</Text>
            ) : (
              actions
                .toReversed()
                .map((action) => <LogLine key={action.at + action.verb} action={action} />)
            )}
          </ScrollView>
        </View>
      </View>
    </View>
  );
}

function Badge({
  label,
  value,
  ok,
  testID,
}: {
  label: string;
  value: string;
  ok: boolean;
  testID: string;
}): ReactNode {
  return (
    <View style={[styles.badge, ok ? styles.badgeOk : styles.badgeWarn]} testID={testID}>
      <Text style={styles.badgeText}>
        {label}: {value}
      </Text>
    </View>
  );
}

const LogLine = memo(function LogLine({ action }: { action: AttackDesktopAction }) {
  const detail = [action.role, action.label ? `"${action.label}"` : null].filter(Boolean).join(" ");
  return (
    <View style={styles.logLine} testID="attack-desktop-log-line">
      <Text style={styles.logTime}>{clockTime(action.at)}</Text>
      <Text style={styles.logVerb}>{action.verb}</Text>
      {detail ? (
        <Text style={styles.logDetail} numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
});

function WindowStill({
  still,
  lastPoint,
}: {
  still: ReturnType<typeof useDesktopStill>["still"];
  lastPoint: AttackDesktopAction | null;
}) {
  const { t } = useTranslation();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox({ width, height });
  }, []);
  const imageSource = useMemo(() => (still ? { uri: still.uri } : undefined), [still]);
  if (!still) {
    return (
      <View style={styles.stillFrame} testID="attack-desktop-still-empty">
        <Text style={styles.emptyText}>{t("attack.subviews.desktop.noPreview")}</Text>
      </View>
    );
  }
  // The image keeps its aspect ratio inside the frame; the ring is placed on the drawn image.
  const scale = Math.min(box.width / still.width, box.height / still.height) || 0;
  const drawnWidth = still.width * scale;
  const drawnHeight = still.height * scale;
  const ring =
    lastPoint?.point && still.windowWidth > 0 && still.windowHeight > 0
      ? {
          left:
            (box.width - drawnWidth) / 2 +
            (lastPoint.point.x / still.windowWidth) * drawnWidth -
            RING_SIZE / 2,
          top:
            (box.height - drawnHeight) / 2 +
            (lastPoint.point.y / still.windowHeight) * drawnHeight -
            RING_SIZE / 2,
        }
      : null;
  return (
    <View style={styles.stillFrame} onLayout={onLayout} testID="attack-desktop-still">
      <Image
        source={imageSource}
        style={styles.stillImage}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
      {ring ? <View style={[styles.ring, ring]} testID="attack-desktop-ring" /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  bar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  owner: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
    flexShrink: 1,
  },
  badge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  badgeOk: { borderColor: theme.colors.border },
  badgeWarn: { borderColor: theme.colors.palette.amber[500] },
  badgeText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  grant: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  grantText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  grantButtons: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  body: { flex: 1, minHeight: 0 },
  bodyWide: { flexDirection: "row" },
  bodyNarrow: { flexDirection: "column" },
  stage: { flex: 1, minWidth: 0, minHeight: 0, padding: theme.spacing[3], gap: theme.spacing[2] },
  stillFrame: {
    flex: 1,
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  stillImage: { width: "100%", height: "100%" },
  ring: {
    position: "absolute",
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 3,
    borderColor: theme.colors.palette.red[500],
  },
  error: { color: theme.colors.palette.amber[500], fontSize: theme.fontSize.sm },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  logWide: {
    width: 260,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderLeftWidth: 1,
    borderColor: theme.colors.border,
  },
  logNarrow: {
    maxHeight: 180,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderColor: theme.colors.border,
  },
  logTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "500" },
  logEmpty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  logLine: { flexDirection: "row", gap: theme.spacing[2], paddingVertical: 2 },
  logTime: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  logVerb: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "500" },
  logDetail: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
