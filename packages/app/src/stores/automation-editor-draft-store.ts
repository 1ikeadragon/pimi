import { create } from "zustand";
import type { AutomationEditorDraft } from "@/automations/automation-editor-model";

/**
 * Unsaved automation edits, kept while the editor is unmounted: leaving for a chat, settings or
 * another automation and coming back finds them again. In memory only; a window reload drops them.
 *
 * Entries are keyed per host and automation (`draftKeyFor`). A sidebar hop leaves the old editor
 * mounted, unfocused, while a reopened one starts, so only the newest editor for a key may write.
 */
interface AutomationEditorDraftStore {
  drafts: Record<string, AutomationEditorDraft>;
  owners: Record<string, symbol>;
}

const useAutomationEditorDraftStore = create<AutomationEditorDraftStore>(() => ({
  drafts: {},
  owners: {},
}));

export function draftKeyFor(input: {
  serverId: string | undefined;
  automationId: string | undefined;
  /** A new automation starts from nothing, a template or a duplicate; each keeps its own draft. */
  origin: string;
}): string {
  return `${input.serverId ?? ""}|${input.automationId ?? input.origin}`;
}

export function readAutomationEditorDraft(key: string): AutomationEditorDraft | null {
  return useAutomationEditorDraftStore.getState().drafts[key] ?? null;
}

/** The editor that mounted last owns the key. */
export function claimAutomationEditorDraft(key: string, owner: symbol): void {
  useAutomationEditorDraftStore.setState((state) => ({
    owners: { ...state.owners, [key]: owner },
  }));
}

/** Stores the editor's draft, or drops it when the editor is clean. */
export function writeAutomationEditorDraft(
  key: string,
  owner: symbol,
  draft: AutomationEditorDraft | null,
): void {
  const { owners, drafts } = useAutomationEditorDraftStore.getState();
  if (owners[key] !== owner) return;
  if (!draft) {
    if (!(key in drafts)) return;
    const { [key]: _dropped, ...rest } = drafts;
    useAutomationEditorDraftStore.setState({ drafts: rest });
    return;
  }
  useAutomationEditorDraftStore.setState({ drafts: { ...drafts, [key]: draft } });
}

export function clearAutomationEditorDraft(key: string): void {
  const { drafts } = useAutomationEditorDraftStore.getState();
  if (!(key in drafts)) return;
  const { [key]: _dropped, ...rest } = drafts;
  useAutomationEditorDraftStore.setState({ drafts: rest });
}
