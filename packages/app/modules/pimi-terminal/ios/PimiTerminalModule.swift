import ExpoModulesCore

public class PimiTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PimiTerminal")

    View(PimiTerminalView.self) {
      Events("onCellMetrics")

      Prop("frame") { (view: PimiTerminalView, frame: TerminalFrameRecord) in view.setFrame(frame) }
      Prop("theme") { (view: PimiTerminalView, theme: TerminalThemeRecord) in view.setTheme(theme) }
      Prop("fontFamily") { (view: PimiTerminalView, family: String) in view.setFontFamily(family) }
      Prop("fontSize") { (view: PimiTerminalView, size: Double) in view.setFontSize(size) }
      Prop("customGlyphs") { (view: PimiTerminalView, glyphs: [TerminalCustomGlyphRecord]) in
        view.setCustomGlyphs(glyphs)
      }

      OnViewDidUpdateProps { (view: PimiTerminalView) in view.commit() }
    }
  }
}
