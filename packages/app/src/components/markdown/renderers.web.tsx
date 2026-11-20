import { Text } from "react-native";
import {
  forwardRef,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentProps,
  type MouseEvent,
} from "react";
import type {
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useAssistantFileLinkActions, useFileLink } from "@/assistant-file-links";
import { useForgeShorthand } from "@/git/forge-shorthand";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  useContextMenu,
} from "@/components/ui/context-menu";
import { i18n } from "@/i18n/i18next";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import {
  parseChatView,
  viewFenceOf,
  type ViewFence as ViewFenceName,
} from "@pimi/protocol/chat-view";
import type { Theme } from "@/styles/theme";
import { MermaidFence, MermaidStreamingContext } from "./fence/mermaid";
import { ViewFence } from "./fence/view";
import { markdownLinkSource } from "./source";
import { isHttpUrl } from "@/utils/http-url";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const codeStyle = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});
function WebCodeBlock({ code, language }: CodeBlockRendererProps) {
  if (language?.toLowerCase() === "mermaid") return <MermaidFence code={code} />;
  return <StreamingCodeBlock code={code} language={language} />;
}
function StreamingCodeBlock({ code, language }: Pick<CodeBlockRendererProps, "code" | "language">) {
  const streaming = useContext(MermaidStreamingContext);
  return (
    <ThemedCodeBlock code={code} language={language} streaming={streaming} uniProps={codeStyle} />
  );
}

/** A view block the segment splitter left in the Markdown, such as one that ended invalid. */
function ViewCodeBlock({ fence, ...props }: CodeBlockRendererProps & { fence: ViewFenceName }) {
  const streaming = useContext(MermaidStreamingContext);
  const view = useMemo(() => parseChatView(fence, props.code), [fence, props.code]);
  return <ViewFence view={view} source={props.code} failed={!view && !streaming} />;
}

function AssistantCodeBlock(props: CodeBlockRendererProps) {
  const fence = viewFenceOf(props.language);
  if (fence) return <ViewCodeBlock {...props} fence={fence} />;
  return <WebCodeBlock {...props} />;
}

// The library styles links inline, so a stylesheet :hover rule cannot underline them.
const LINK_HOVER_STYLE = { textDecoration: "underline" } as const;

function WebLink({ link, anchorProps, children }: LinkRendererProps) {
  const forgeShorthand = useForgeShorthand();
  // A forge reference like `#12` carries its web URL so hover, copy and new-tab opens work.
  const forgeUrl = link.sourceType === "text" ? forgeShorthand?.resolve(link.url) : null;
  const source = forgeUrl
    ? markdownLinkSource(forgeUrl)
    : markdownLinkSource(link.url, link.sourceType);
  const { tooltipPath, onHoverIn } = useFileLink(source);
  const { canResolveFile, openInIde } = useAssistantFileLinkActions();
  const href = forgeUrl ?? anchorProps.href;
  // Cmd/Ctrl-click and middle-click send a web link to the system browser instead of Pimi's.
  const opensExternally = useCallback(
    () => Boolean(href && isHttpUrl(href) && !canResolveFile(source)),
    [canResolveFile, href, source],
  );
  const { onClick } = anchorProps;
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if ((event.metaKey || event.ctrlKey) && href && opensExternally()) {
        event.preventDefault();
        void openExternalUrl(href);
        return;
      }
      onClick?.(event);
    },
    [href, onClick, opensExternally],
  );
  const handleAuxClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 1 || !href || !opensExternally()) return;
      event.preventDefault();
      void openExternalUrl(href);
    },
    [href, opensExternally],
  );
  const [menuPoint, setMenuPoint] = useState<MenuPoint | null>(null);
  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!openInIde || forgeUrl || !canResolveFile(source)) return;
      event.preventDefault();
      setMenuPoint({ x: event.clientX, y: event.clientY });
    },
    [canResolveFile, forgeUrl, openInIde, source],
  );
  const closeMenu = useCallback(() => setMenuPoint(null), []);
  const openMenuTargetInIde = useCallback(() => openInIde?.(source), [openInIde, source]);
  const tooltip = forgeUrl ?? tooltipPath;
  const [hovered, setHovered] = useState(false);
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const anchorStyle = useMemo(
    () => ({
      ...anchorProps.style,
      overflowWrap: "anywhere" as const,
      ...(hovered ? LINK_HOVER_STYLE : null),
    }),
    [anchorProps.style, hovered],
  );
  const anchor = (
    <a
      {...anchorProps}
      href={href}
      style={anchorStyle}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </a>
  );
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild onHoverIn={onHoverIn}>
        <InlineLinkTrigger>{anchor}</InlineLinkTrigger>
      </TooltipTrigger>
      {tooltip ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltip}
          </Text>
        </TooltipContent>
      ) : null}
      {menuPoint ? (
        <PathLinkMenu point={menuPoint} onClose={closeMenu} onOpenInIde={openMenuTargetInIde} />
      ) : null}
    </Tooltip>
  );
}

interface MenuPoint {
  x: number;
  y: number;
}

/** Mounted only while open, so a reply's links carry no menu state. */
function PathLinkMenu({
  point,
  onClose,
  onOpenInIde,
}: {
  point: MenuPoint;
  onClose: () => void;
  onOpenInIde: () => void;
}) {
  const handleOpenChange = useCallback(
    (open: boolean) => (open ? undefined : onClose()),
    [onClose],
  );
  return (
    <ContextMenu defaultOpen onOpenChange={handleOpenChange}>
      <MenuAnchor point={point} />
      <ContextMenuContent minWidth={180} testID="chat-path-link-menu">
        <ContextMenuItem onSelect={onOpenInIde} testID="chat-path-link-open-in-ide">
          {i18n.t("ideMode.openInIde")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MenuAnchor({ point }: { point: MenuPoint }) {
  const { setAnchorRect } = useContextMenu();
  useLayoutEffect(() => {
    setAnchorRect({ x: point.x, y: point.y, width: 0, height: 0 });
  }, [point.x, point.y, setAnchorRect]);
  return null;
}
// TooltipTrigger also supplies native Pressable handlers; forward only DOM events.
// A View renders a div, which is invalid inside the library's prose paragraphs.
const InlineLinkTrigger = forwardRef<HTMLSpanElement, ComponentProps<"span">>(
  function InlineLinkTrigger({ children, onMouseEnter, onMouseLeave, onFocus, onBlur }, ref) {
    return (
      <span
        ref={ref}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </span>
    );
  },
);
const styles = StyleSheet.create((theme) => ({
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

export const WEB_RENDERERS: MarkdownRenderers = { codeBlock: WebCodeBlock, link: WebLink };
export const ASSISTANT_WEB_RENDERERS: MarkdownRenderers = {
  codeBlock: AssistantCodeBlock,
  link: WebLink,
};
