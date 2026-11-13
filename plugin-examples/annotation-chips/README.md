# Annotation chips plugin example

Draws each composer annotation as a compact chip: `file.ts:12-18`, the first words of the quote,
and a remove button. Clicking the label goes to the annotated source.

Annotations are chips inside the composer's text on web and desktop, and in the attachment tray on
native. The chip reads `placement` and `layout.lineHeight` to fit the line it sits in.

It uses two composer contributions:

- `client.addAttachmentRenderer({ kind: "annotation", Component })` replaces the default chip and
  hover card. Pimi shows the default chip again when this component throws or the plugin is off.
- `client.composer.active()` returns the composer the user last used on this host. The chip removes
  itself through `composer.attachments.remove(id)`, which also removes its character from the text.

Backspace removes a chip natively now that it is a character in the text, so the plugin carries no
key handler. The plugin has no server entry. It declares `>=0.17.37` for `placement`.
