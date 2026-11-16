export const ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT = 32_000;

export interface CappedAssistantMessage {
  text: string;
  capped: boolean;
}
