import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "@/i18n/use-translation";
import { AnnotationLimitError } from "@/composer/chips/model";
import { useToast } from "@/contexts/toast-context";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { ANNOTATION_CHARACTER_LIMIT, type AnnotationAttachment } from "./model";
import { AnnotationSheet } from "./sheet";
import {
  AnnotationTargetUnavailableError,
  addAnnotationToChat,
  focusAnnotationTarget,
  removeAnnotation,
  saveAnnotationNote,
} from "./target";

type ChatAnnotate = (
  message: { messageId: string; role: "user" | "assistant" },
  quote: string,
) => Promise<void>;

const ChatAnnotateContext = createContext<ChatAnnotate | null>(null);

/** Annotates chat text on touch layouts, where the selection menu and message buttons call it. */
export function useChatAnnotate(): ChatAnnotate | null {
  return useContext(ChatAnnotateContext);
}

export function ChatAnnotateProvider({
  target,
  children,
}: {
  target: { serverId: string; agentId: string } | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [editing, setEditing] = useState<AnnotationAttachment | null>(null);
  const saved = useRef(false);
  const serverId = target?.serverId;
  const agentId = target?.agentId;
  const annotationTarget = useMemo(
    () =>
      serverId && agentId
        ? { serverId, agentId, draftKey: buildDraftStoreKey({ serverId, agentId }) }
        : null,
    [serverId, agentId],
  );

  const annotate = useCallback<ChatAnnotate>(
    async ({ messageId, role }, quote) => {
      if (!annotationTarget || !serverId || !agentId || !quote.trim()) return;
      if (quote.length > ANNOTATION_CHARACTER_LIMIT) {
        toast.error(t("chips.selectionTooLong"));
        return;
      }
      try {
        const attachment = await addAnnotationToChat(annotationTarget, {
          quote,
          source: { kind: "chat", serverId, agentId, messageId, role },
        });
        saved.current = false;
        setEditing(attachment);
      } catch (error) {
        if (
          !(
            error instanceof AnnotationTargetUnavailableError ||
            error instanceof AnnotationLimitError
          )
        )
          throw error;
        toast.error(error.message);
      }
    },
    [annotationTarget, serverId, agentId, toast, t],
  );

  const save = useCallback(
    (note: string) => {
      if (!annotationTarget || !editing) return;
      saved.current = true;
      saveAnnotationNote(annotationTarget, editing.id, note);
      focusAnnotationTarget(annotationTarget);
    },
    [annotationTarget, editing],
  );
  const close = useCallback(() => {
    if (annotationTarget && editing && !saved.current)
      removeAnnotation(annotationTarget, editing.id);
    setEditing(null);
  }, [annotationTarget, editing]);

  return (
    <ChatAnnotateContext.Provider value={annotationTarget ? annotate : null}>
      {children}
      {editing ? <AnnotationSheet attachment={editing} onSave={save} onClose={close} /> : null}
    </ChatAnnotateContext.Provider>
  );
}
