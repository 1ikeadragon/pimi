import { memo, useMemo, useState } from "react";
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

import { MermaidFence, MermaidStreamingContext, splitMermaidFences } from "./fence/mermaid";
import { Visualization } from "./fence/visualization";
import { ChatArtifactCard } from "./fence/artifact";

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
}

/** All Markdown surfaces share the same engine and source adaptation. */
export const MarkdownRenderer = memo(function MarkdownRenderer(props: MarkdownRendererProps) {
  // Same-reply chart identities must share one segment registry across streaming boundaries.
  const streaming =
    !isWeb &&
    !!props.streaming &&
    !(props.visualizations && /pimi-(?:chart|artifact)/i.test(props.text));
  // Only completed lines affect block closure. Do not run mdast on every reveal frame.
  const completeLines = streaming ? props.text.slice(0, props.text.lastIndexOf("\n") + 1) : "";
  const boundary = useMemo(
    () => splitStreamingMarkdown(completeLines, true).head.length,
    [completeLines],
  );
  const Part = props.agentCommands ? CommandMarkdownPart : MarkdownPart;
  if (!streaming || boundary === 0) return <Part {...props} />;
  return (
    <MarkdownBlockStack>
      <Part {...props} text={props.text.slice(0, boundary)} />
      <Part {...props} text={props.text.slice(boundary)} />
    </MarkdownBlockStack>
  );
});

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
        : splitMermaidFences(markdown, visualizations, !isWeb),
    [markdown, visualizations],
  );
  return (
    <MermaidStreamingContext.Provider value={streaming}>
      <MarkdownBlockStack imageSources={imageSources}>
        {segments.map((segment) => {
          const key = `${segment.kind}:${segment.id}`;
          if (segment.kind === "mermaid") return <MermaidFence key={key} code={segment.source} />;
          if (segment.kind === "visualization")
            return <Visualization key={key} chart={segment.chart} />;
          if (segment.kind === "artifact")
            return <ChatArtifactCard key={key} artifact={segment.artifact} />;
          return (
            <ThemedMarkdown
              key={key}
              markdown={segment.source}
              uniProps={pickMarkdownStyle(compact, muted)}
              flavor="github"
              selectable={selectable}
              md4cFlags={MD4C_FLAGS}
              linkRecognition={linkRecognition}
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
