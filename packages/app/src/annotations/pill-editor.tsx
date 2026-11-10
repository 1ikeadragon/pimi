import type { RefObject } from "react";
import type { View } from "react-native";
import type { AnnotationEditSession } from "./edit-session";

/** Native edits a note in the sheet; the anchored editor is web-only. */
export function AnnotationPillEditor(_props: {
  session: AnnotationEditSession;
  pill: RefObject<View | null>;
}) {
  return null;
}
