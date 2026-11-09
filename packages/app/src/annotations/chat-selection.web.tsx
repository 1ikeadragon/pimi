import { createAssistantSelectionClipboardContent } from "@/assistant-selection-copy/content.web";
import { getOverlayRoot, useGlobalOverlayLayer } from "@/lib/overlay-root";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MessageSquarePlus } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { SPACING } from "@/styles/theme";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { AnnotationSheet } from "./sheet";
import { addAnnotationToChat, type AnnotationTarget } from "./target";
import { ANNOTATION_CHARACTER_LIMIT, type AnnotationCapture } from "./model";

interface SelectionCapture {
  capture: AnnotationCapture;
  left: number;
  top: number;
}
const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };
function keepSelection(event: MouseEvent<HTMLDivElement>) {
  event.preventDefault();
}

function messageAtSelectionEdge(
  node: Node,
  root: HTMLElement,
): { id: string; role: "user" | "assistant" } | null {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element || !root.contains(element) || !element.closest('[data-message-text="true"]'))
    return null;
  const message = element.closest(
    '[data-testid="user-message"], [data-testid="assistant-message"]',
  );
  const id = element.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
  if (!message || !id) return null;
  return {
    id,
    role: message.getAttribute("data-testid") === "user-message" ? "user" : "assistant",
  };
}

function captureSelection(
  root: HTMLElement,
  target: { serverId: string; agentId: string },
): SelectionCapture | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const start = messageAtSelectionEdge(range.startContainer, root);
  const end = messageAtSelectionEdge(range.endContainer, root);
  if (!start || !end || start.id !== end.id || start.role !== end.role) return null;
  // Reuse the copy serializer for Markdown boundaries, retaining code whitespace for snapshots.
  const selectedText = selection.toString();
  const quote =
    start.role === "assistant" && selectedText.length <= ANNOTATION_CHARACTER_LIMIT
      ? createAssistantSelectionClipboardContent(selection, {
          preserveSelectedCodeWhitespace: true,
        })?.plainText
      : selectedText;
  if (!quote?.trim()) return null;
  const rect = range.getBoundingClientRect();
  if ((!rect.width && !rect.height) || rect.bottom <= 0 || rect.top >= window.innerHeight)
    return null;
  return {
    capture: { quote, source: { kind: "chat", ...target, messageId: start.id, role: start.role } },
    left: rect.left,
    top: rect.bottom,
  };
}

export function ChatAnnotationSelection({
  children,
  target,
}: {
  children: ReactNode;
  target?: { serverId: string; agentId: string };
}) {
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<SelectionCapture | null>(null);
  const [draft, setDraft] = useState<{
    capture: AnnotationCapture;
    target: AnnotationTarget;
  } | null>(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!toolbar.current || !selection) return;
    const { width, height } = toolbar.current.getBoundingClientRect();
    setToolbarSize((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, [selection]);
  const overlayLayer = useGlobalOverlayLayer("floating", Boolean(selection));
  const serverId = target?.serverId;
  const agentId = target?.agentId;
  useEffect(() => {
    setSelection(null);
    if (!serverId || !agentId || draft) return;
    let frame = 0;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Tabbing to the action must not discard the selected source.
        if (toolbar.current?.contains(document.activeElement)) return;
        setSelection(
          root.current
            ? captureSelection(root.current, { serverId: serverId!, agentId: agentId! })
            : null,
        );
      });
    }
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerup", update);
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerup", update);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [serverId, agentId, draft]);
  const annotate = useCallback(() => {
    if (!selection || !serverId || !agentId) return;
    setDraft({
      capture: selection.capture,
      target: { serverId, agentId, draftKey: buildDraftStoreKey({ serverId, agentId }) },
    });
    setSelection(null);
  }, [selection, serverId, agentId]);
  const closeDraft = useCallback(() => setDraft(null), []);
  const saveDraft = useCallback(
    async (note: string) => {
      if (!draft) throw new Error("The annotation is no longer available.");
      await addAnnotationToChat(draft.target, draft.capture, note);
    },
    [draft],
  );
  const toolbarStyle = useMemo<CSSProperties>(() => {
    if (!selection) return {};
    return {
      position: "fixed",
      left: Math.max(
        SPACING[2],
        Math.min(selection.left, window.innerWidth - toolbarSize.width - SPACING[2]),
      ),
      top: Math.max(
        SPACING[2],
        Math.min(selection.top + SPACING[2], window.innerHeight - toolbarSize.height - SPACING[2]),
      ),
      zIndex: overlayLayer,
      pointerEvents: "auto",
    };
  }, [selection, toolbarSize, overlayLayer]);

  return (
    <>
      <div ref={root} style={DISPLAY_CONTENTS}>
        {children}
      </div>
      {selection && target
        ? createPortal(
            <div ref={toolbar} onMouseDown={keepSelection} style={toolbarStyle}>
              <View style={styles.action}>
                <Button
                  leftIcon={MessageSquarePlus}
                  onPress={annotate}
                  accessibilityLabel="Annotate selected text"
                  testID="annotate-chat-selection"
                >
                  Annotate
                </Button>
              </View>
            </div>,
            getOverlayRoot(),
          )
        : null}
      {draft ? (
        <AnnotationSheet
          capture={draft.capture}
          canSave={Boolean(
            target && serverId === draft.target.serverId && agentId === draft.target.agentId,
          )}
          onClose={closeDraft}
          onSave={saveDraft}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  action: {
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[1],
  },
}));
