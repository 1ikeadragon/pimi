import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { DiagramColorScheme } from "./render-model";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const codeStyle = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});

/**
 * Native chats open a diagram in their own full-screen viewer (`host.native.tsx`), so a diagram
 * tab only comes from web. If one is shown here anyway, it shows the source.
 */
export function MermaidTabView({ source }: { source: string; colorScheme: DiagramColorScheme }) {
  return <ThemedCodeBlock code={source} language="mermaid" uniProps={codeStyle} />;
}
