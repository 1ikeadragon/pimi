import { restoreSentChips, type RestoredChips } from "@/composer/chips/model";
import { generateMessageId } from "@/types/stream";
import type { AgentAttachment } from "@pimi/protocol/messages";
import type { ComposerTextSource } from "@/composer/text-source";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

interface RewindComposerRestoreContextValue {
  completeRewind: (text: string, attachments: readonly AgentAttachment[]) => void;
}

interface RewindComposerRestoreProviderProps {
  textSource: ComposerTextSource;
  setText: (text: string) => void;
  /** Restores the sent message's chips into the draft: gives the text and its annotations. */
  restoreChips: (restore: (reservedSlots: readonly number[]) => RestoredChips) => RestoredChips;
  onRewindComplete: () => void;
  children: ReactNode;
}

const RewindComposerRestoreContext = createContext<RewindComposerRestoreContextValue | null>(null);

export function RewindComposerRestoreProvider({
  textSource,
  setText,
  restoreChips,
  onRewindComplete,
  children,
}: RewindComposerRestoreProviderProps) {
  const completeRewind = useCallback(
    (rewoundText: string, attachments: readonly AgentAttachment[]) => {
      const currentText = textSource.getSnapshot();
      if (currentText.length > 0) {
        onRewindComplete();
        return;
      }
      const restored = restoreChips((reserved) =>
        restoreSentChips({ text: rewoundText, attachments, reserved, newId: generateMessageId }),
      );
      setText(restored.text);
      onRewindComplete();
    },
    [onRewindComplete, restoreChips, setText, textSource],
  );

  const value = useMemo(() => ({ completeRewind }), [completeRewind]);

  return (
    <RewindComposerRestoreContext.Provider value={value}>
      {children}
    </RewindComposerRestoreContext.Provider>
  );
}

export function useRewindComposerRestore(): RewindComposerRestoreContextValue | null {
  return useContext(RewindComposerRestoreContext);
}
