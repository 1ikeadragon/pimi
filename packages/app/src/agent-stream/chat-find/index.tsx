import type { ReactNode } from "react";
import type { ChatFindProps, ChatFindExpansionProps } from "./types";

export function ChatFind({ children }: ChatFindProps) {
  return children;
}
export function ChatFindExpansion({ children }: ChatFindExpansionProps) {
  return children(false);
}
export function ChatMessageReveal({ children }: { messageId: string | null; children: ReactNode }) {
  return children;
}
/** Native has no chat find and no virtualizer to keep a message's rows mounted for. */
export function useAddressableMessageId(): string | null {
  return null;
}
