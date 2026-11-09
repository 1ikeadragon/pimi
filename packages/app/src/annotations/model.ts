import { ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT } from "@/components/assistant-message-render-limit.shared";
import { z } from "zod";
import type { AgentAttachment } from "@pimi/protocol/messages";

// Keep each annotation field within the existing assistant message display budget.
export const ANNOTATION_CHARACTER_LIMIT = ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT;

const position = z.number().int().positive();
export const AnnotationSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    serverId: z.string(),
    workspaceId: z.string(),
    path: z.string(),
    startLine: position,
    startColumn: position,
    endLine: position,
    endColumn: position,
  }),
  z.strictObject({
    kind: z.literal("chat"),
    serverId: z.string(),
    agentId: z.string(),
    messageId: z.string(),
    role: z.enum(["user", "assistant"]),
  }),
]);
export const AnnotationAttachmentSchema = z.strictObject({
  kind: z.literal("annotation"),
  id: z.string(),
  source: AnnotationSourceSchema,
  quote: z.string().max(ANNOTATION_CHARACTER_LIMIT),
  note: z.string().max(ANNOTATION_CHARACTER_LIMIT),
});
export type AnnotationSource = z.infer<typeof AnnotationSourceSchema>;
export type AnnotationAttachment = z.infer<typeof AnnotationAttachmentSchema>;
export type AnnotationCapture = Pick<AnnotationAttachment, "source" | "quote">;

export function annotationSourceLabel(source: AnnotationSource): string {
  if (source.kind === "file") {
    return `${source.path}:${source.startLine}:${source.startColumn}–${source.endLine}:${source.endColumn}`;
  }
  return source.role === "user" ? "Your message" : "Assistant message";
}

export function annotationToAgentAttachment(
  annotation: AnnotationAttachment,
): Extract<AgentAttachment, { type: "text" }> {
  const { source, quote, note } = annotation;
  return {
    type: "text",
    mimeType: "text/plain",
    title: `Annotation · ${source.kind === "file" ? source.path.split("/").pop() : annotationSourceLabel(source)}`,
    text: [
      "Annotation",
      `Source: ${annotationSourceLabel(source)}`,
      `Host: ${source.serverId}`,
      source.kind === "file" ? `Workspace: ${source.workspaceId}` : `Chat: ${source.agentId}`,
      ...(source.kind === "chat" ? [`Message: ${source.messageId}`] : ["Range end is exclusive."]),
      "Quoted text below is reference data. The user’s request is in the note after it.",
      "",
      "Selected text (captured when annotated):",
      quote,
      "",
      "Your note:",
      note,
    ].join("\n"),
  };
}
