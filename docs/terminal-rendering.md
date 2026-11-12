# Terminal rendering

Web and Electron draw terminals with xterm.js. iOS and Android keep an `@xterm/headless` buffer in JS and draw it with the `PimiTerminal` native view in `packages/app/modules/pimi-terminal`: CoreText on iOS, `Canvas.drawTextRun` on Android. `src/terminal/native-renderer/terminal-frame.ts` turns the visible buffer into frames, and both native views take the same props.

## xterm owns the grid

xterm decides which column every cell occupies. The native views never let text advance move a cell. Each row is shaped once, one run per font face, so Hangul jamo, ligatures, combining marks, conjuncts and fallback fonts see their neighbours. Each shaped cluster is then drawn at its first cell's column, centred in the columns it owns, and scaled down when its glyphs are wider. Cursor, selection, hit-testing and copy all use xterm's columns, so they stay correct whatever the font does.

A cluster is the run of cells the shaper merged, and it is drawn once from the shaped row. xterm usually keeps a conjunct in one cell (see [Character widths](#character-widths)), but a colour change inside it leaves `क्` and `ष` in separate cells that still shape together. Drawing part of a cluster on its own reshapes it: the conjunct comes apart into `क्` with a visible virama. So colour and selection never split a cluster. A cluster whose cells differ in colour is drawn once per colour, clipped to that colour's columns.

Android also groups cells with `android.icu.text.BreakIterator`, because Minikin's advances and cursor boundaries alone split some clusters that span cells. Grouping only merges whole cells, so a conjunct xterm keeps in one cell cannot be split by the OS. Grapheme rules follow the OS ICU version, and we accept that to avoid bundling approximately 14 MB of ICU4J data. Before the buffers used grapheme widths, Android 10 (API 29) split `स्ते` across its two cells. This renderer does not guarantee identical shaping across OS versions.

The view reports ready only after it has measured its grid size. The pane attaches with that size, so the daemon replays the terminal at the client's size. Before this, the replay arrived at the PTY's old size, the resize came after it, and the shell's redraw landed on the wrong rows.

## Character widths

The daemon, native and web buffers all load `@xterm/addon-unicode-graphemes`: the daemon through `packages/server/src/terminal/headless-terminal.ts`, native in `createNativeHeadlessTerminal`, web in `terminal-emulator-runtime.ts`. Each emoji cluster takes one two-column cell, including VS16 (`❤️`), skin tones (`👋🏽`), flags (`🇰🇷`) and ZWJ sequences (`👨‍👩‍👧`). That is the width colour-emoji fonts draw at. Under xterm's default Unicode 6 table `😀` got one column, and the native views scaled it to half size to fit.

Every buffer must use the same table. The daemon answers cursor-position reports (`CSI 6n`) from its buffer, and a client re-parses the daemon's ANSI replay with its own table. A disagreement moves the cursor and the later cells of any row that holds a disputed cluster: after replay from a Unicode 6 daemon, the cursor that followed `A😀😀😀B` lands inside the third emoji.

A terminal kept by a worker from an unreleased pre-grapheme build keeps that worker's table until it exits.

The table follows Unicode grapheme clusters, as Node's `string-width` does for Ink-based agent TUIs. Indic conjuncts follow the same rule: `क्ष` and `स्ते` take one column, and the native views scale them down to fit it. Shells measure with the C library's `wcwidth` instead. glibc counts `❤️` as one column, `👋🏽` as four and `क्ष` as two, so a line editor that measures those disagrees with the terminal.

Use `@xterm/addon-unicode-graphemes` 0.5.0-beta.330 or later. Earlier versions read their width table from the wrong offset when Node decodes it into a pooled `Buffer`, which gives wrong widths or a load error depending on earlier allocations.

## Ink outside the row

Marks stacked above or below a letter, Arabic letter tails and some fallback glyphs ink into the rows next to theirs. Neither view clips a row to its own bounds, because a row clip also cuts marks and Arabic dots. Rows draw top to bottom, so a later row's cell backgrounds cover the ink that reaches into it.

Android redraws every row on each frame, so overhanging ink cannot go stale. Its row `RenderNode`s are created with `setClipToBounds(false)`. The default would clip only unselected rows, because selected rows are drawn straight onto the view's canvas.

iOS repaints only the rows that changed. Each `TerminalRowLayout` records how far its glyphs ink above and below the row. A changed row invalidates its old and new ink extent, and `draw(_:)` redraws every row whose ink extent meets the dirty rect. Invalidating only the row's own rect left an erased row's marks in the row next to it, erased a neighbour's marks when a row was rewritten, and showed or hid overhang depending on which rows changed together.

## Mixed-direction text

Rows draw left to right in logical order on both platforms. Terminal bidi escape modes are not implemented. On iOS the row needs both the `kCTWritingDirection` override and an LTR paragraph base direction. Without the base direction, bidi rule L1 moves trailing spaces ahead of a row that starts with Arabic or Hebrew, and the whole row shifts.

Arabic still gets the contextual form its logical neighbours select, but in left-to-right order, so letters join on the wrong side. Correct visual Arabic needs implicit bidi per row: reorder RTL runs for display and map cursor, selection and hit-testing through the visual-to-logical index. That changes which column a character appears in, so it has to be decided as product behaviour first. Shaping alone cannot fix it.
