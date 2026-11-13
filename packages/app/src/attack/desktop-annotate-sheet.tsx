import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Camera, Check, Trash2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AttackDesktopTarget } from "@pimi/protocol/attack/types";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { cropDesktopRegion, type DesktopRegion } from "./annotation-image";
import { captureDesktopStill, type DesktopStill } from "./use-desktop-target";

const MIN_SIZE = 8;
/** A rectangle the owner marked, in pixels of the still the agents' screenshot also uses. */
export interface DesktopNote {
  id: number;
  region: DesktopRegion;
  note: string;
  imageBase64: string | null;
}

interface Draft {
  id: number;
  region: DesktopRegion;
  note: string;
}

function toRegion(
  from: { x: number; y: number },
  to: { x: number; y: number },
  limit: { width: number; height: number },
): DesktopRegion {
  const left = Math.max(0, Math.min(from.x, to.x));
  const top = Math.max(0, Math.min(from.y, to.y));
  const right = Math.min(limit.width, Math.max(from.x, to.x));
  const bottom = Math.min(limit.height, Math.max(from.y, to.y));
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

/**
 * The owner marks regions on a fresh still of the picked desktop window and types a note for each.
 * Saving crops every region from the still (a JPEG at most 640 px wide) and hands the notes back;
 * the parent labels them A1, A2, ... after the browser notes.
 */
export function DesktopAnnotateSheet({
  target,
  initialNotes,
  onSave,
  onCancel,
}: {
  target: AttackDesktopTarget;
  initialNotes: readonly DesktopNote[];
  onSave: (notes: DesktopNote[]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [still, setStill] = useState<DesktopStill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(true);
  // Drafts are in still pixels; notes already saved keep their region, and a new still replaces
  // the picture they were drawn on, so retaking drops nothing but does not re-crop old regions.
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    initialNotes.map((item) => ({ id: item.id, region: item.region, note: item.note })),
  );
  const [drag, setDrag] = useState<{
    from: { x: number; y: number };
    to: { x: number; y: number };
  } | null>(null);
  const [width, setWidth] = useState(0);
  const [saving, setSaving] = useState(false);
  const nextId = useRef(Math.max(0, ...initialNotes.map((item) => item.id)));
  const dragRef = useRef(drag);

  const capture = useCallback(async () => {
    setCapturing(true);
    const result = await captureDesktopStill("preflight", target);
    if (result.still) {
      setStill(result.still);
      setError(null);
    } else {
      setError(result.error);
    }
    setCapturing(false);
  }, [target]);
  useEffect(() => {
    void capture();
  }, [capture]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const scale = still && width > 0 ? still.width / width : 0;
  const height = still && scale > 0 ? still.height / scale : 0;

  const point = useCallback(
    (event: GestureResponderEvent) => ({
      x: event.nativeEvent.locationX * scale,
      y: event.nativeEvent.locationY * scale,
    }),
    [scale],
  );
  const shouldRespond = useCallback(() => scale > 0, [scale]);
  const onGrant = useCallback(
    (event: GestureResponderEvent) => {
      const start = point(event);
      dragRef.current = { from: start, to: start };
      setDrag(dragRef.current);
    },
    [point],
  );
  const onMove = useCallback(
    (event: GestureResponderEvent) => {
      const next = point(event);
      if (!dragRef.current) return;
      dragRef.current = { from: dragRef.current.from, to: next };
      setDrag(dragRef.current);
    },
    [point],
  );
  const onRelease = useCallback(() => {
    if (!still) return;
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!current) return;
    const region = toRegion(current.from, current.to, still);
    if (region.width < MIN_SIZE || region.height < MIN_SIZE) return;
    nextId.current += 1;
    const id = nextId.current;
    setDrafts((list) => [...list, { id, region, note: "" }]);
  }, [still]);

  const onRemove = useCallback((id: number) => {
    setDrafts((list) => list.filter((item) => item.id !== id));
  }, []);
  const onNote = useCallback((id: number, note: string) => {
    setDrafts((list) => list.map((item) => (item.id === id ? { ...item, note } : item)));
  }, []);

  const onSavePress = useCallback(async () => {
    if (!still) {
      onSave([...initialNotes]);
      return;
    }
    setSaving(true);
    const notes: DesktopNote[] = [];
    for (const draft of drafts) {
      const imageBase64 = await cropDesktopRegion(still.uri, draft.region);
      notes.push({
        id: draft.id,
        region: draft.region,
        note: draft.note.trim().slice(0, 2000),
        imageBase64,
      });
    }
    setSaving(false);
    onSave(notes);
  }, [drafts, initialNotes, onSave, still]);
  const onSaveClick = useCallback(() => void onSavePress(), [onSavePress]);
  const onRetake = useCallback(() => void capture(), [capture]);

  const dragRegion = useMemo(
    () => (drag && still ? toRegion(drag.from, drag.to, still) : null),
    [drag, still],
  );
  const imageSource = useMemo(() => (still ? { uri: still.uri } : undefined), [still]);
  // The picture and rectangles share one scale; a rectangle is drawn at region / scale.
  const box = (region: DesktopRegion) =>
    scale > 0
      ? {
          left: region.x / scale,
          top: region.y / scale,
          width: region.width / scale,
          height: region.height / scale,
        }
      : null;

  return (
    <View style={styles.root} testID="attack-desktop-annotate">
      <View style={styles.header}>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={ArrowLeft}
          onPress={onCancel}
          testID="attack-desktop-annotate-cancel"
        >
          {t("attack.desktopAnnotate.cancel")}
        </Button>
        <Text style={styles.title} numberOfLines={1}>
          {t("attack.desktopAnnotate.title")} · {target.appName}
        </Text>
      </View>
      <Text style={styles.hint}>{t("attack.desktopAnnotate.hint")}</Text>
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          leftIcon={Camera}
          onPress={onRetake}
          disabled={capturing}
          testID="attack-desktop-annotate-retake"
        >
          {t("attack.desktopAnnotate.retake")}
        </Button>
      </View>
      <View style={styles.stage} onLayout={onLayout}>
        {still ? (
          <View
            style={[styles.frame, { height }]}
            onStartShouldSetResponder={shouldRespond}
            onMoveShouldSetResponder={shouldRespond}
            onResponderGrant={onGrant}
            onResponderMove={onMove}
            onResponderRelease={onRelease}
            testID="attack-desktop-annotate-still"
          >
            <Image
              source={imageSource}
              style={styles.image}
              resizeMode="stretch"
              accessibilityIgnoresInvertColors
            />
            {drafts.map((draft, index) => {
              const place = box(draft.region);
              return place ? (
                <View key={draft.id} pointerEvents="none" style={[styles.rect, place]}>
                  <Text style={styles.rectLabel}>{index + 1}</Text>
                </View>
              ) : null;
            })}
            {dragRegion && box(dragRegion) ? (
              <View pointerEvents="none" style={[styles.rect, styles.rectDraft, box(dragRegion)]} />
            ) : null}
          </View>
        ) : (
          <Text style={styles.hint}>
            {capturing ? t("attack.desktopAnnotate.capturing") : (error ?? "")}
          </Text>
        )}
      </View>
      {error && still ? <Text style={styles.error}>{error}</Text> : null}
      {drafts.map((draft, index) => (
        <View
          key={draft.id}
          style={styles.noteRow}
          testID={`attack-desktop-annotate-note-${index + 1}`}
        >
          <Text style={styles.noteIndex}>{index + 1}</Text>
          <View style={styles.noteInput}>
            <DraftNote id={draft.id} index={index} initial={draft.note} onChange={onNote} />
          </View>
          <RemoveButton id={draft.id} index={index} onRemove={onRemove} />
        </View>
      ))}
      <Button
        variant="default"
        leftIcon={Check}
        loading={saving}
        disabled={saving}
        onPress={onSaveClick}
        testID="attack-desktop-annotate-save"
      >
        {t("attack.desktopAnnotate.save")}
      </Button>
    </View>
  );
}

function DraftNote({
  id,
  index,
  initial,
  onChange,
}: {
  id: number;
  index: number;
  initial: string;
  onChange: (id: number, note: string) => void;
}) {
  const { t } = useTranslation();
  const onChangeText = useCallback((value: string) => onChange(id, value), [id, onChange]);
  const label = t("attack.desktopAnnotate.noteFor", { label: index + 1 });
  return (
    <FormTextInput
      size="md"
      accessibilityLabel={label}
      initialValue={initial}
      onChangeText={onChangeText}
      placeholder={t("attack.desktopAnnotate.notePlaceholder")}
    />
  );
}

function RemoveButton({
  id,
  index,
  onRemove,
}: {
  id: number;
  index: number;
  onRemove: (id: number) => void;
}) {
  const { t } = useTranslation();
  const onPress = useCallback(() => onRemove(id), [id, onRemove]);
  return (
    <PressHighlight
      onPress={onPress}
      accessibilityLabel={t("attack.preflight.remove")}
      testID={`attack-desktop-annotate-remove-${index + 1}`}
    >
      <Trash2 size={14} color="currentColor" />
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { width: "100%", gap: theme.spacing[3] },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
  stage: { width: "100%" },
  frame: {
    width: "100%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  image: { width: "100%", height: "100%" },
  rect: {
    position: "absolute",
    borderWidth: 2,
    borderColor: theme.colors.palette.red[500],
    backgroundColor: "rgba(239,68,68,0.15)",
  },
  rectDraft: { borderStyle: "dashed" },
  rectLabel: {
    position: "absolute",
    top: 0,
    left: 0,
    paddingHorizontal: 4,
    color: "white",
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.palette.red[600],
  },
  error: { color: theme.colors.palette.amber[500], fontSize: theme.fontSize.sm },
  noteRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  noteIndex: {
    width: 18,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  noteInput: { flex: 1, minWidth: 0 },
}));
