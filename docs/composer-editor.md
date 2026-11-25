# Composer editor

How the composer holds annotation chips: the token model, the reconcile rules, and the gotchas that are not visible from the code. Source: `packages/app/src/composer/chips/`, `packages/app/src/components/ui/chip-text-editor/`, `packages/app/src/annotations/chip-host.tsx`.

## The token model

An annotation is one Private Use Area code unit in the draft text, `U+E000 + slot`, and an `AnnotationAttachment` with that `slot` in the draft's attachments. One code unit means cut, paste, Backspace and selection treat a chip like any character, and the plugin API, autocomplete and recall keep working on a flat string with plain UTF-16 offsets. The cap is 32 slots, the size of the code unit range; the daemon has no per-message clamp of its own.

Chip characters never leave the client. `prepareComposerSubmission` (`composer/attachments/submit.ts`) is the single choke point: chips become `[annotation N]` numbered in text order, and the annotation bodies follow in the same order as `Annotation N` envelopes with a matching `ref` in their metadata. Sent messages draw a chip wherever `[annotation N]` has an attachment with that `ref`. `[annotation N]` typed by hand stays text unless such an attachment exists.

## Sources

An annotation names where its quote came from: a `file` range, a `chat` message, a `browser` element, or a `diff` range. A diff source is lines of one side of a Review comparison: `side` `old` numbers the base version's lines, `new` the working version's. Review notes become diff annotations when the user sends them to a chat (`review-screen/desk/send-notes.ts`). Three things about them are easy to get wrong:

- The quote carries a `+`, `-` or space before each line, so the agent can tell added, removed and unchanged lines apart. The agent's `Source:` line says `removed lines` for the old side and `vs <baseRef>` when the comparison named one.
- A note whose text left the diff is still sent. Its quote is what the note stored, led by `(no longer in the diff)`; the anchor holds text only, so those lines have no `+`/`-` markers.
- Go to source opens Review at the first line (`annotations/go-to-source.ts`), never the file editor: the editor shows the working copy, which has none of the removed lines. A removed line has no new-side number, so Review scrolls to the line that took its place (`review-screen/desk/focus-line.ts`).

Sending moves notes one at a time: a note leaves the review after its chip is in the draft, and the loop stops at the 32 annotation cap or the first error, so what was not sent is still in Review. The daemon does not enforce the cap, so only the client's slot count holds it.

## Who writes what

- The mounted editor owns the text. The draft store never edits text on its own, except `editDraftText`, which reconciles a published edit (below).
- `reconcileAfterTextChange` runs in `editDraftText`. A chip that vanished detaches its annotation into a runtime stash (`detachedAnnotationsByDraftKey`, not persisted, cleared when the draft is cleared); a chip that reappears (undo) reattaches from the stash; a chip that appears twice (copy and paste) is cloned with a new id and slot; a chip that names no annotation is dropped. An annotation whose chip was never in the previous text is left alone, because the composer is about to place it.
- `reconcileAfterAttachmentsChange` runs from an effect in `composer/index.tsx`. It drops chips whose annotation was removed (plugin, tray) and inserts a chip at the last caret for an annotation that has none, padded with a space where it would touch a word. A composer that was never focused places it at the end.
- Anything that adds annotations together with text (recall, rewind, paste) must allocate slots inside the `setAttachments` updater, which receives `reservedSlots` (the stash). Allocating outside it can reuse a slot undo still wants.

## Editor gotchas

- Replace text by diff, never wholesale: a full replace drops undo history and the chip DOM, closing open hover cards and note editors.
- `reset()` and draft switches swap the `EditorState`, or Cmd+Z brings back a sent message.
- The editor's keydown handler sits above CodeMirror's keymap (`Prec.highest`), or Enter inserts a line before the composer sees it. It keeps the `isComposing` check, because Japanese and Chinese input confirm with Enter.
- CodeMirror handles presses on its content line only, and gives `.cm-scroller` `tabIndex = -1`. A press below the line focused the scroller, the next key went nowhere, and the scroller matched the global `*:focus-visible` ring. `composer/input/surface-focus.web.ts` claims every press on the composer box that no control takes and focuses the editor with the caret at the end.
- Chip widgets `preventDefault` on `mousedown` so a stray click does not move focus out of the editor. Tab still reaches a chip.
- CodeMirror's own paste and drop handlers insert the text of dropped files. The editor claims them so `composer/attachments/drop.ts` and the paste-image effect keep ownership.
- Chips render through `createPortal` into widget spans, so they get unistyles, i18n and plugin providers. Do not call `useUnistyles()`; the editor theme uses CSS variables.

## Native

`TextInput` cannot host views and is deliberately uncontrolled. The native adapter (`chip-text-editor/index.native.tsx`) maps a chip to a circled numeral of the same length (`U+2460..2473`, then `U+3251..325C`), and the tray shows each annotation as a chip with the same numeral. Everything above the adapter sees chip characters. A circled numeral typed by the user becomes a chip.
