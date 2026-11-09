import { historyField } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// Retain recent saved tabs, not editor DOM or callbacks. UTF-16 strings use at most
// about 8 MiB of payload at this budget; older/oversized histories start fresh.
const MAX_RETAINED_TABS = 16;
const MAX_RETAINED_CHARACTERS = 4 * 1024 * 1024;
const historyFields = { history: historyField };
interface RetainedEditor {
  content: string;
  json: string;
  navigation: string | null;
  scroll: ReturnType<EditorView["scrollSnapshot"]>;
  size: number;
}
const retained = new Map<string, RetainedEditor>();
let retainedCharacters = 0;

function remove(key: string): RetainedEditor | undefined {
  const entry = retained.get(key);
  if (entry) {
    retained.delete(key);
    retainedCharacters -= entry.size;
  }
  return entry;
}

export function takeRetainedEditor(key: string, content: string | null, extensions: Extension) {
  const entry = remove(key);
  if (!entry || entry.content !== content) return null;
  return {
    state: EditorState.fromJSON(JSON.parse(entry.json), { extensions }, historyFields),
    navigation: entry.navigation,
    scroll: entry.scroll,
  };
}

export function retainEditor(
  key: string,
  view: EditorView,
  savedContent: string | null,
  navigation: string | null,
): void {
  remove(key);
  if (savedContent === null || !view.state.doc.eq(view.state.toText(savedContent))) return;
  const json = JSON.stringify(view.state.toJSON(historyFields));
  const size = key.length + savedContent.length + json.length + (navigation?.length ?? 0);
  if (size > MAX_RETAINED_CHARACTERS) return;
  while (
    retained.size >= MAX_RETAINED_TABS ||
    retainedCharacters + size > MAX_RETAINED_CHARACTERS
  ) {
    const oldest = retained.keys().next().value;
    if (oldest === undefined) break;
    remove(oldest);
  }
  retained.set(key, {
    content: savedContent,
    json,
    navigation,
    scroll: view.scrollSnapshot(),
    size,
  });
  retainedCharacters += size;
}
