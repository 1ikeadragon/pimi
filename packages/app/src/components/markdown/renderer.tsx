import { memo, useContext, useMemo, useRef, useState, type ComponentProps } from "react";
import { EnrichedMarkdownText, type LinkPressEvent } from "react-native-enriched-markdown";
import { withUnistyles } from "react-native-unistyles";
import {
  useAssistantFileLinkActions,
  useAssistantFileLinkEnvironment,
} from "@/assistant-file-links";
import { useStableEvent } from "@/hooks/use-stable-event";
import { matchCommandLink, useAgentCommandHints, type CommandHints } from "@/agent-commands";
import { useForgeShorthand } from "@/git/forge-shorthand";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import { density, resolveDensity } from "@/styles/density";
import { MarkdownBlockStack } from "./block-stack";
import { ASSISTANT_WEB_RENDERERS, WEB_RENDERERS } from "./renderers";
import { createMarkdownStyles } from "./styles";
import { PENDING_MARKDOWN_IMAGE } from "./source";
import { splitStreamingMarkdown } from "./streaming";
import { useMarkdownSource, type MarkdownImageContext } from "./images";

import { MermaidFence, MermaidStreamingContext } from "./fence/mermaid";
import { PIMI_FENCE_PATTERN, splitMermaidFences } from "./fence/mermaid/segments";
import { ViewFence } from "./fence/view";
import { ChatArtifactCard, ChatHtmlCard } from "./fence/artifact";
import { VegaFence } from "./fence/vega";

const ThemedMarkdown = withUnistyles(EnrichedMarkdownText);
const MD4C_FLAGS = { latexMath: false, hardSoftBreaks: true, admonitions: true };

// Reading the breakpoint here makes Unistyles restyle the text when the layout crosses it.
const markdownStyle =
  (compact: boolean, muted = false) =>
  (theme: Theme, rt: { breakpoint?: string }) =>
    createMarkdownStyles(theme, {
      compact,
      muted,
      blockGap: resolveDensity(rt, density.blockGap),
    });
const regularStyle = markdownStyle(false);
const compactStyle = markdownStyle(true);
const compactMutedStyle = markdownStyle(true, true);

function pickMarkdownStyle(compact: boolean, muted: boolean) {
  if (!compact) return regularStyle;
  return muted ? compactMutedStyle : compactStyle;
}

export interface MarkdownRendererProps extends MarkdownImageContext {
  text: string;
  compact?: boolean;
  /** Muted text colour. Compact surfaces only. */
  muted?: boolean;
  selectable?: boolean;
  streaming?: boolean;
  onLinkPress?: (url: string) => unknown;
  agentCommands?: boolean;
  visualizations?: boolean;
  /** Native selection-menu items. */
  contextMenuItems?: ComponentProps<typeof EnrichedMarkdownText>["contextMenuItems"];
}

/** All Markdown surfaces share the same engine and source adaptation. */
export const MarkdownRenderer = memo(function MarkdownRenderer(props: MarkdownRendererProps) {
  // Same-reply view identities must share one segment registry across streaming boundaries.
  const streaming =
    !isWeb && !!props.streaming && !(props.visualizations && PIMI_FENCE_PATTERN.test(props.text));
  // Only completed lines affect block closure. Do not run mdast on every reveal frame.
  const completeLines = streaming ? props.text.slice(0, props.text.lastIndexOf("\n") + 1) : "";
  const boundary = useStreamingBoundary(completeLines);
  const Part = props.agentCommands ? CommandMarkdownPart : MarkdownPart;
  if (!streaming || boundary === 0) return <Part {...props} />;
  return (
    <MarkdownBlockStack>
      {/* The head holds closed blocks only. Web draws its code blocks highlighted in full. */}
      <Part {...props} streaming={!isWeb} text={props.text.slice(0, boundary)} />
      <Part {...props} text={props.text.slice(boundary)} />
    </MarkdownBlockStack>
  );
});

/**
 * Length of the closed-block head of a streaming reply. Closed blocks never reopen, so each
 * update parses only the source after the previous boundary instead of the whole reply.
 */
function useStreamingBoundary(completeLines: string): number {
  const headRef = useRef("");
  return useMemo(() => {
    if (!completeLines.startsWith(headRef.current)) headRef.current = "";
    const closed = splitStreamingMarkdown(completeLines.slice(headRef.current.length), true).head;
    headRef.current += closed;
    return headRef.current.length;
  }, [completeLines]);
}

const CommandMarkdownPart = memo(function CommandMarkdownPart(props: MarkdownRendererProps) {
  const commandHints = useAgentCommandHints();
  return <MarkdownPart {...props} commandHints={commandHints} />;
});

const MarkdownPart = memo(function MarkdownPart({
  text,
  compact = false,
  muted = false,
  selectable = true,
  streaming = false,
  onLinkPress,
  agentCommands: _agentCommands,
  visualizations = false,
  contextMenuItems,
  commandHints = null,
  ...imageContext
}: MarkdownRendererProps & { commandHints?: CommandHints | null }) {
  const environment = useAssistantFileLinkEnvironment();
  const actions = useAssistantFileLinkActions();
  const forgeShorthand = useForgeShorthand();
  const client =
    imageContext.client ??
    (environment.client?.readFile
      ? { readFile: environment.client.readFile.bind(environment.client) }
      : undefined);
  const { markdown, imageSources, linkRecognition, linkSource } = useMarkdownSource(
    text,
    {
      workspaceRoot: environment.workspaceRoot,
      serverId: environment.serverId,
      ...imageContext,
      client,
    },
    { commandNames: commandHints?.names, forgeReferencePattern: forgeShorthand?.pattern },
  );
  // Source adaptation creates an object per update. Keep its equivalent regexes stable so
  // appending text does not invalidate every completed web block's memo boundary.
  const recognitionText = linkRecognition.text;
  const inlineCodeSource = linkRecognition.inlineCode.source;
  const inlineCodeFlags = linkRecognition.inlineCode.flags;
  const stableLinkRecognition = useMemo(
    () => ({ text: recognitionText, inlineCode: new RegExp(inlineCodeSource, inlineCodeFlags) }),
    [recognitionText, inlineCodeSource, inlineCodeFlags],
  );
  const [image, setImage] = useState<ImageLightboxSource | null>(null);
  const pressLink = useStableEvent(({ url, sourceType }: LinkPressEvent) => {
    const command = commandHints && matchCommandLink(url, sourceType, commandHints.names);
    if (command) {
      commandHints.insert(command);
      return;
    }
    const forgeUrl = sourceType === "text" ? forgeShorthand?.resolve(url) : null;
    if (forgeUrl) {
      actions.open({ href: forgeUrl }, "preferred");
      return;
    }
    const source = linkSource(url, sourceType);
    if (onLinkPress && !actions.canResolveFile(source)) onLinkPress(url);
    else actions.open(source, "preferred");
  });
  const pressImage = useStableEvent(({ url }: { url: string }) => {
    if (url !== PENDING_MARKDOWN_IMAGE) setImage({ type: "uri", uri: url });
  });
  const closeImage = useStableEvent(() => setImage(null));
  const segments = useMemo(
    () =>
      isWeb && !visualizations
        ? [{ kind: "markdown" as const, id: "0", source: markdown }]
        : splitMermaidFences(markdown, { visualizations, mermaid: !isWeb, streaming }),
    [markdown, visualizations, streaming],
  );
  return (
    <MermaidStreamingContext.Provider value={streaming}>
      <MarkdownBlockStack imageSources={imageSources}>
        {segments.map((segment) => {
          const key = `${segment.kind}:${segment.id}`;
          if (segment.kind === "mermaid") return <MermaidFence key={key} code={segment.source} />;
          if (segment.kind === "view")
            return (
              <ViewFence
                key={key}
                view={segment.view}
                source={segment.source}
                failed={segment.failed}
              />
            );
          if (segment.kind === "vega")
            return (
              <VegaFence
                key={key}
                vega={segment.vega}
                source={segment.source}
                failed={segment.failed}
              />
            );
          if (segment.kind === "html")
            return (
              <ChatHtmlCard
                key={key}
                html={segment.html}
                source={segment.source}
                failed={segment.failed}
              />
            );
          if (segment.kind === "artifact")
            return <ChatArtifactCard key={key} artifact={segment.artifact} />;
          return (
            <MarkdownText
              key={key}
              markdown={segment.source}
              uniProps={pickMarkdownStyle(compact, muted)}
              flavor="github"
              selectable={selectable}
              contextMenuItems={contextMenuItems}
              md4cFlags={MD4C_FLAGS}
              linkRecognition={stableLinkRecognition}
              enableTaskListItemToggle={false}
              enableLinkPreview={false}
              enableBlockContextMenu={false}
              // JS reveal owns pacing; native fade animation is a separate experiment.
              streamingAnimation={false}
              onLinkPress={pressLink}
              onImagePress={pressImage}
              renderers={visualizations ? ASSISTANT_WEB_RENDERERS : WEB_RENDERERS}
            />
          );
        })}
      </MarkdownBlockStack>
      {image ? <AttachmentLightbox source={image} onClose={closeImage} /> : null}
    </MermaidStreamingContext.Provider>
  );
});

/** Web selection spans elements; native selection needs one text view per segment. */
const MarkdownText = memo(function MarkdownText(props: ComponentProps<typeof ThemedMarkdown>) {
  if (!isWeb) return <ThemedMarkdown {...props} />;
  return <WebMarkdownBlocks {...props} />;
});

const MarkdownBlock = memo(ThemedMarkdown);

function WebMarkdownBlocks(props: ComponentProps<typeof ThemedMarkdown>) {
  const { markdown = "" } = props;
  const streaming = useContext(MermaidStreamingContext);
  const closed = useRef({ source: "", blocks: [] as { source: string; offset: number }[] });
  const completeLines = markdown.slice(0, markdown.lastIndexOf("\n") + 1);
  const blocks = useMemo(() => {
    if (!completeLines.startsWith(closed.current.source)) {
      closed.current = { source: "", blocks: [] };
    }
    const next = splitStreamingMarkdown(completeLines.slice(closed.current.source.length), true);
    if (next.head) {
      let offset = closed.current.source.length;
      const additions = next.blocks.map((source) => {
        const block = { source, offset };
        offset += source.length;
        return block;
      });
      closed.current = {
        source: closed.current.source + next.head,
        blocks: [...closed.current.blocks, ...additions],
      };
    }
    return closed.current.blocks;
  }, [completeLines]);
  const tail = markdown.slice(closed.current.source.length);
  return (
    <MarkdownBlockStack>
      {blocks.map((block) => (
        <MermaidStreamingContext.Provider key={block.offset} value={false}>
          <MarkdownBlock {...props} markdown={block.source} />
        </MermaidStreamingContext.Provider>
      ))}
      {tail ? (
        <MermaidStreamingContext.Provider key={closed.current.source.length} value={streaming}>
          <MarkdownBlock {...props} markdown={tail} />
        </MermaidStreamingContext.Provider>
      ) : null}
    </MarkdownBlockStack>
  );
}
