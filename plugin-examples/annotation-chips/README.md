# Annotation chips plugin example

Draws each composer annotation as a compact chip: `file.ts:12-18`, the first words of the quote,
and a remove button. Clicking the label goes to the annotated source. Backspace with the caret at
the start of the draft removes the newest annotation.

It uses three composer contributions:

- `client.addAttachmentRenderer({ kind: "annotation", Component })` replaces the default pill and
  hover card. Pimi shows the default pill again when this component throws or the plugin is off.
- `client.composer.active()` returns the composer the user last used on this host. The chip removes
  itself through `composer.attachments.remove(id)`.
- `composer.onKeyDown` backs the Backspace shortcut. Key events exist on web and desktop only, so
  native keeps the chips and the remove button without the shortcut.

The plugin has no server entry. It declares `>=0.17.31`, the first version with the composer API.
