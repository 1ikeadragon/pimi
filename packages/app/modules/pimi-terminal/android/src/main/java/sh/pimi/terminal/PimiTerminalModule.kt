package sh.pimi.terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PimiTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PimiTerminal")

    View(PimiTerminalView::class) {
      Events("onCellMetrics")

      Prop("frame") { view: PimiTerminalView, frame: TerminalFrameRecord -> view.setFrame(frame) }
      Prop("theme") { view: PimiTerminalView, theme: TerminalThemeRecord -> view.setTheme(theme) }
      Prop("fontFamily") { view: PimiTerminalView, family: String -> view.setFontFamily(family) }
      Prop("fontSize") { view: PimiTerminalView, size: Double -> view.setFontSize(size) }
      Prop("customGlyphs") { view: PimiTerminalView, glyphs: List<TerminalCustomGlyphRecord> ->
        view.setCustomGlyphs(glyphs)
      }

      OnViewDidUpdateProps { view: PimiTerminalView -> view.commit() }
    }
  }
}
