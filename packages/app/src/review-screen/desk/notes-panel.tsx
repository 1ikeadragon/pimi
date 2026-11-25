// Pimi. PolyForm-Noncommercial-1.0.0.
// The user's review notes as a list: where each one is, what it says, and a way to go to, edit or
// delete it. It takes the thread dock's slot (docked at THREAD_PANEL_DOCK_MIN_WIDTH, else a
// sheet). Notes whose quoted text left the diff sit under their own heading; they stay sendable.
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Pencil, Trash2, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useTranslation } from "@/i18n/use-translation";
import { noteStartLine } from "@/review/anchor";
import { InlineReviewEditor } from "@/review";
import type { ReviewDraftComment } from "@/review/state";
import type { Theme } from "@/styles/theme";
import { THREAD_PANEL_WIDTH, useCloseOnEscape } from "./thread-panel";

const ThemedClose = withUnistyles(X);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerMapping = (theme: Theme) => ({ color: theme.colors.destructive });

/** `path:12` or `path:12-18`: the same shape the chip and the agent's envelope use. */
export function noteLocation(note: ReviewDraftComment): string {
  const start = noteStartLine(note);
  return start === note.lineNumber
    ? `${note.filePath}:${start}`
    : `${note.filePath}:${start}-${note.lineNumber}`;
}

function firstLine(body: string): string {
  return body.split("\n", 1)[0] ?? "";
}

export interface NotesListProps {
  notes: readonly ReviewDraftComment[];
  outdated: readonly ReviewDraftComment[];
  onJump: (note: ReviewDraftComment) => void;
  onSave: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}

function NoteRow({
  note,
  onJump,
  onSave,
  onDelete,
}: { note: ReviewDraftComment } & Omit<NotesListProps, "notes" | "outdated">) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const jump = useCallback(() => onJump(note), [note, onJump]);
  const startEdit = useCallback(() => {
    setDraft(note.body);
    setEditing(true);
  }, [note.body]);
  const cancelEdit = useCallback(() => setEditing(false), []);
  const save = useCallback(
    (body: string) => {
      onSave(note.id, body);
      setEditing(false);
    },
    [note.id, onSave],
  );
  const remove = useCallback(() => onDelete(note.id), [note.id, onDelete]);
  if (editing) {
    return (
      <View style={styles.row}>
        <InlineReviewEditor
          body={draft}
          onChangeBody={setDraft}
          onCancel={cancelEdit}
          onSave={save}
          saveLabel={t("reviewScreen.notes.save")}
          testID={`review-note-editor-${note.id}`}
        />
      </View>
    );
  }
  return (
    <View style={styles.row} testID={`review-note-${note.id}`}>
      <PressHighlight
        style={styles.rowMain}
        onPress={jump}
        accessibilityRole="button"
        accessibilityLabel={t("reviewScreen.notes.jump", { location: noteLocation(note) })}
      >
        <View style={styles.locationLine}>
          <Text style={styles.location} numberOfLines={1} ellipsizeMode="head">
            {noteLocation(note)}
          </Text>
          {note.side === "old" ? (
            <StatusBadge size="xs" variant="warning" label={t("reviewScreen.notes.removed")} />
          ) : null}
        </View>
        <Text style={styles.body} numberOfLines={2}>
          {firstLine(note.body)}
        </Text>
      </PressHighlight>
      <View style={styles.actions}>
        <ToolbarButton label={t("review.comment.edit")} onPress={startEdit}>
          <ThemedPencil size={14} uniProps={mutedMapping} />
        </ToolbarButton>
        <ToolbarButton label={t("review.comment.delete")} onPress={remove}>
          <ThemedTrash size={14} uniProps={dangerMapping} />
        </ToolbarButton>
      </View>
    </View>
  );
}

export function NotesList({ notes, outdated, onJump, onSave, onDelete }: NotesListProps) {
  const { t } = useTranslation();
  return (
    <View testID="review-notes-list">
      {notes.map((note) => (
        <NoteRow key={note.id} note={note} onJump={onJump} onSave={onSave} onDelete={onDelete} />
      ))}
      {outdated.length > 0 ? (
        <>
          <Text style={styles.group}>{t("reviewScreen.notes.outdated")}</Text>
          {outdated.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              onJump={onJump}
              onSave={onSave}
              onDelete={onDelete}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

/** The docked form; `NotesSheet` is the sheet form. */
export function NotesPanel(props: NotesListProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const { onClose, ...list } = props;
  useCloseOnEscape(true, onClose);
  return (
    <View style={styles.panel} testID="review-notes-panel">
      <View style={styles.head}>
        <Text style={styles.title}>{t("reviewScreen.notes.title")}</Text>
        <ToolbarButton label={t("common.actions.close")} onPress={onClose}>
          <ThemedClose size={14} uniProps={mutedMapping} />
        </ToolbarButton>
      </View>
      <ScrollView>
        <NotesList {...list} />
      </ScrollView>
    </View>
  );
}

export function NotesSheet(props: NotesListProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const { onClose, ...list } = props;
  const header = useMemo<SheetHeader>(() => ({ title: t("reviewScreen.notes.title") }), [t]);
  useCloseOnEscape(true, onClose);
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="review-notes-sheet">
      <NotesList {...list} />
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    width: THREAD_PANEL_WIDTH,
    minHeight: 0,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.borderWindow,
    backgroundColor: theme.colors.surfaceChrome,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  group: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[1],
  },
  rowMain: { flex: 1, minWidth: 0, paddingVertical: theme.spacing[2], gap: theme.spacing[1] },
  locationLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  location: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  body: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row", alignItems: "center" },
}));
