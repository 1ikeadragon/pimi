export type KeyboardFocusScope =
  | "terminal"
  | "message-input"
  | "command-center"
  | "editable"
  | "editor"
  | "browser"
  | "other";

export type MessageInputKeyboardActionKind =
  | "focus"
  | "send"
  | "dictation-toggle"
  | "dictation-cancel"
  | "dictation-confirm"
  | "voice-toggle"
  | "voice-mute-toggle"
  | "mode-cycle";

export type KeyboardActionId =
  | "agent.interrupt"
  | "agent.new"
  | "plugin.command"
  | "workspace.tab.menu.open"
  | "workspace.tab.target.agent"
  | "workspace.tab.target.browser"
  | "workspace.tab.target.changes"
  | "workspace.tab.target.files"
  | "workspace.tab.close.current"
  | "workspace.tab.navigate.index"
  | "workspace.tab.navigate.relative"
  | "workspace.pane.split.right"
  | "workspace.pane.split.down"
  | "workspace.pane.focus.left"
  | "workspace.pane.focus.right"
  | "workspace.pane.focus.up"
  | "workspace.pane.focus.down"
  | "workspace.pane.move-tab.left"
  | "workspace.pane.move-tab.right"
  | "workspace.pane.move-tab.up"
  | "workspace.pane.move-tab.down"
  | "workspace.pane.close"
  | "workspace.navigate.index"
  | "workspace.navigate.relative"
  | "sidebar.toggle.left"
  | "sidebar.toggle.right"
  | "sidebar.toggle.both"
  | "settings.toggle"
  | "command-center.toggle"
  | "command-center.files"
  | "command-center.commands"
  | "pane.find"
  | "pane.find.next"
  | "pane.find.previous"
  | "pane.find.toggle-case"
  | "pane.find.toggle-word"
  | "pane.find.toggle-regex"
  | "pane.replace"
  | "search.workspace"
  | "search.replace"
  | "editor.add-next-occurrence"
  | "editor.select-all-occurrences"
  | "editor.go-to-line"
  | "editor.go-to-symbol"
  | "shortcuts.dialog.toggle"
  | "workspace.terminal.new"
  | "workspace.new"
  | "workspace.project.pick"
  | "worktree.new"
  | "workspace.archive"
  | "workspace.archive.undo"
  | "workspace.pin"
  | "view.toggle.focus"
  | "theme.step"
  | "message-input.action";

export type KeyboardShortcutPayload =
  | { index: number }
  | { delta: 1 | -1 }
  | { kind: MessageInputKeyboardActionKind }
  /** A plugin's Command Center item, by `<pluginId>:<itemId>`. */
  | { pluginCommand: string }
  | null;
