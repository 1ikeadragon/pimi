import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CalendarClock, Crosshair, StickyNote, Swords, Trash2, X } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  MAX_ATTACK_ANNOTATIONS,
  type AttackAnnotation,
  type AttackAnnotationInput,
} from "@pimi/protocol/attack/types";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachments,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Switch } from "@/components/ui/switch";
import { getDesktopHost } from "@/desktop/host";
import { removeResidentBrowserWebview } from "@/desktop/browser/resident-webviews";
import { createWorkspaceBrowser, useBrowserStore } from "@/desktop/browser/store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { isWeb } from "@/constants/platform";
import { FocusPanel } from "./attack-agent-focus";
import { LaunchForm } from "./attack-launch-form";
import { useAnnotationImages } from "./annotation-image";
import { useAttackStore } from "./attack-store";

/** Below this window width the notes column becomes an overlay over the target. */
export const ATTACK_NARROW_WIDTH = 1000;

type BrowserElementItem = Extract<WorkspaceComposerAttachment, { kind: "browser_element" }>;

function isElement(attachment: WorkspaceComposerAttachment): attachment is BrowserElementItem {
  return attachment.kind === "browser_element";
}

/** The element attachments that become annotations, in the order they were added. */
function annotationElements(
  attachments: readonly WorkspaceComposerAttachment[],
): BrowserElementItem[] {
  return attachments.filter(isElement).slice(0, MAX_ATTACK_ANNOTATIONS);
}

/**
 * The owner's marked elements as the run definition carries them: A1, A2, ... in the order added,
 * each with its element screenshot (by attachment id) once that has been read and shrunk.
 */
export function toAttackAnnotations(
  attachments: readonly WorkspaceComposerAttachment[],
  images: ReadonlyMap<string, string>,
): AttackAnnotationInput[] {
  return annotationElements(attachments).map((item, index) => {
    const screenshot = item.attachment.screenshot;
    const imageBase64 = screenshot ? images.get(screenshot.id) : undefined;
    const annotation: AttackAnnotationInput = {
      label: `A${index + 1}`,
      url: item.attachment.url.slice(0, 2000),
      selector: item.attachment.selector.slice(0, 1000),
      tag: item.attachment.tag.slice(0, 100),
      text: item.attachment.text.trim().slice(0, 400),
      html: item.attachment.outerHTML.trim().slice(0, 800),
      note: (item.attachment.comment ?? "").trim().slice(0, 2000),
      hasImage: imageBase64 !== undefined,
    };
    if (imageBase64) annotation.imageBase64 = imageBase64;
    return annotation;
  });
}

function releaseBrowser(browserId: string): void {
  removeResidentBrowserWebview(browserId);
  void getDesktopHost()?.browser?.unregisterWorkspaceBrowser?.(browserId);
  useBrowserStore.getState().removeBrowser(browserId);
}

/**
 * The launch form, with an optional pre-flight: the target open in a live browser the owner marks
 * up with the browser's Annotate tool. The form stays mounted in one place whether or not a
 * pre-flight is open, so what the owner typed survives opening and skipping it.
 */
export function AttackCompose({
  serverId,
  workspaceId,
  formKey,
  narrow,
}: {
  serverId: string;
  workspaceId: string;
  formKey: string;
  narrow: boolean;
}) {
  const { t } = useTranslation();
  const key = `${serverId}:${workspaceId}`;
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const preflight = useAttackStore((state) => state.preflightByWorkspace[key] ?? null);
  const scopeKey = useMemo(
    () => (cwd ? buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd }) : ""),
    [cwd, serverId, workspaceId],
  );
  const attachments = useWorkspaceAttachments(scopeKey);
  const screenshots = useMemo(
    () => annotationElements(attachments).map((item) => item.attachment.screenshot),
    [attachments],
  );
  const images = useAnnotationImages(screenshots);
  const annotations = useMemo(
    () => toAttackAnnotations(attachments, images),
    [attachments, images],
  );
  const [onlyAnnotated, setOnlyAnnotated] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const showPanel = !preflight || !narrow || panelOpen;
  const overlay = Boolean(preflight && narrow);
  let panelStyle: typeof styles.center | typeof styles.overlay | typeof styles.side = styles.center;
  if (preflight) panelStyle = overlay ? styles.overlay : styles.side;

  const closePreflight = useCallback(() => {
    const open = useAttackStore.getState().preflightByWorkspace[key];
    if (!open) return;
    useAttackStore.getState().setPreflight(key, null);
    releaseBrowser(open.browserId);
    setPanelOpen(false);
    setOnlyAnnotated(false);
  }, [key]);
  // Notes belong to the pre-flight; they leave with it so they do not ride along in a chat.
  const discardNotes = useCallback(() => {
    if (!scopeKey) return;
    const store = useWorkspaceAttachmentsStore.getState();
    const rest = (store.attachmentsByScope[scopeKey] ?? []).filter((item) => !isElement(item));
    store.setWorkspaceAttachments({ scopeKey, attachments: rest });
  }, [scopeKey]);
  const onSkip = useCallback(() => {
    discardNotes();
    closePreflight();
  }, [closePreflight, discardNotes]);
  const onStarted = useCallback(() => {
    discardNotes();
    closePreflight();
  }, [closePreflight, discardNotes]);
  const onOpenPreflight = useCallback(
    (target: string) => {
      if (useAttackStore.getState().preflightByWorkspace[key]) return;
      const { browserId } = createWorkspaceBrowser({ initialUrl: target });
      useAttackStore.getState().setPreflight(key, { browserId, target });
    },
    [key],
  );
  const onRemove = useCallback(
    (index: number) => {
      if (!scopeKey) return;
      const store = useWorkspaceAttachmentsStore.getState();
      const current = store.attachmentsByScope[scopeKey] ?? [];
      let seen = -1;
      store.setWorkspaceAttachments({
        scopeKey,
        attachments: current.filter((item) => {
          if (!isElement(item)) return true;
          seen += 1;
          return seen !== index;
        }),
      });
    },
    [scopeKey],
  );
  const onSchedules = useCallback(
    () => useAttackStore.getState().setSchedulesOpen(key, true),
    [key],
  );
  const onTogglePanel = useCallback(() => setPanelOpen((open) => !open), []);
  const onClosePanel = useCallback(() => setPanelOpen(false), []);

  // Leaving the board (or the form) must not leave the pre-flight browser running.
  useEffect(
    () => () => {
      const open = useAttackStore.getState().preflightByWorkspace[key];
      if (!open) return;
      useAttackStore.getState().setPreflight(key, null);
      releaseBrowser(open.browserId);
    },
    [key],
  );
  useEffect(() => {
    if (!isWeb || !overlay || !panelOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanelOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay, panelOpen]);

  const browserTarget = useMemo(
    () => (preflight ? ({ kind: "browser", browserId: preflight.browserId } as const) : null),
    [preflight],
  );

  return (
    <View style={styles.root} testID="attack-compose">
      {browserTarget ? (
        <View style={styles.browser} testID="attack-preflight-browser">
          {overlay ? (
            // The browser's native view sits above page content, so the badge gets its own strip.
            <View style={styles.badgeBar}>
              <Button
                size="sm"
                variant="default"
                leftIcon={StickyNote}
                onPress={onTogglePanel}
                testID="attack-preflight-badge"
              >
                {t("attack.preflight.badge", { count: annotations.length })}
              </Button>
            </View>
          ) : null}
          <View style={styles.browserBody}>
            <FocusPanel target={browserTarget} />
          </View>
        </View>
      ) : null}
      {overlay && panelOpen ? (
        <PressHighlight
          onPress={onClosePanel}
          style={styles.backdrop}
          accessibilityLabel={t("attack.preflight.close")}
          testID="attack-preflight-backdrop"
        >
          <View />
        </PressHighlight>
      ) : null}
      <View
        style={[panelStyle, showPanel ? null : styles.hidden]}
        testID={preflight ? "attack-preflight-panel" : "attack-board-idle"}
      >
        <ScrollView contentContainerStyle={styles.column}>
          {overlay ? (
            <View style={styles.overlayHeader}>
              <Text style={styles.heading}>{t("attack.preflight.title")}</Text>
              <Button
                size="sm"
                variant="ghost"
                leftIcon={X}
                onPress={onClosePanel}
                accessibilityLabel={t("attack.preflight.close")}
                testID="attack-preflight-close"
              />
            </View>
          ) : (
            <View style={styles.hero}>
              <Swords size={18} color="currentColor" />
              <Text style={styles.heading}>
                {preflight ? t("attack.preflight.title") : t("attack.board.title")}
              </Text>
              {preflight ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={CalendarClock}
                  onPress={onSchedules}
                  testID="attack-schedules-button"
                >
                  {t("attack.schedules.title")}
                </Button>
              )}
            </View>
          )}
          {preflight ? (
            <View style={styles.notes} testID="attack-preflight-notes">
              <Text style={styles.hint}>{t("attack.preflight.hint")}</Text>
              {annotations.length === 0 ? (
                <Text style={styles.empty}>{t("attack.preflight.empty")}</Text>
              ) : (
                annotations.map((item, index) => (
                  <NoteRow
                    key={`${item.label}:${item.selector}`}
                    item={item}
                    index={index}
                    onRemove={onRemove}
                  />
                ))
              )}
              {annotations.length > 0 ? (
                <View style={styles.toggleRow}>
                  <Text style={styles.toggleText}>{t("attack.preflight.onlyAnnotated")}</Text>
                  <Switch
                    value={onlyAnnotated}
                    onValueChange={setOnlyAnnotated}
                    accessibilityLabel={t("attack.preflight.onlyAnnotated")}
                    testID="attack-only-annotated"
                  />
                </View>
              ) : null}
              <Button size="sm" variant="outline" onPress={onSkip} testID="attack-preflight-skip">
                {t("attack.preflight.skip")}
              </Button>
            </View>
          ) : null}
          <LaunchForm
            key={formKey}
            serverId={serverId}
            workspaceId={workspaceId}
            annotations={annotations}
            onlyAnnotated={onlyAnnotated && annotations.length > 0}
            preflightOpen={preflight !== null}
            onOpenPreflight={onOpenPreflight}
            onStarted={onStarted}
          />
        </ScrollView>
      </View>
    </View>
  );
}

function NoteRow({
  item,
  index,
  onRemove,
}: {
  item: AttackAnnotation;
  index: number;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <View style={styles.note} testID={`attack-note-${item.label}`}>
      <Crosshair size={12} color="currentColor" />
      <View style={styles.noteBody}>
        <Text style={styles.noteLabel}>
          {item.label} · {`<${item.tag}>`}
        </Text>
        <Text style={styles.noteText} numberOfLines={3}>
          {item.note || t("attack.preflight.noNote")}
        </Text>
        <Text style={styles.noteSelector} numberOfLines={1}>
          {item.selector}
        </Text>
      </View>
      <PressHighlight
        onPress={press}
        accessibilityLabel={t("attack.preflight.remove")}
        testID={`attack-note-remove-${item.label}`}
      >
        <Trash2 size={14} color="currentColor" />
      </PressHighlight>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, flexDirection: "row" },
  browser: { flex: 1, minWidth: 0, minHeight: 0 },
  badgeBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  browserBody: { flex: 1, minHeight: 0 },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  center: { flex: 1, minWidth: 0 },
  side: {
    width: 380,
    flexShrink: 0,
    borderLeftWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: "92%",
    maxWidth: 420,
    zIndex: 11,
    borderLeftWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  hidden: { display: "none" },
  column: {
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    flexGrow: 1,
    justifyContent: "center",
  },
  hero: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  overlayHeader: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  heading: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, fontWeight: "500" },
  notes: { width: "100%", gap: theme.spacing[2] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  note: {
    flexDirection: "row",
    gap: theme.spacing[2],
    alignItems: "flex-start",
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  noteBody: { flex: 1, minWidth: 0, gap: 2 },
  noteLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "500" },
  noteText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  noteSelector: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  toggleText: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flexShrink: 1 },
}));
