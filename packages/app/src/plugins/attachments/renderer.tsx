import { PluginClientStateProvider } from "@pimi/plugin/client/host";
import type { PluginAttachmentRendererProps, PluginComposerAttachment } from "@pimi/plugin/client";
import type { PluginTheme } from "@pimi/plugin";
import React, { useCallback, useMemo, type ComponentType } from "react";
import { withUnistyles } from "react-native-unistyles";
import { AnnotationPill } from "@/annotations/pill";
import { goToSentAnnotationSource } from "@/annotations/go-to-source";
import type { AnnotationAttachment } from "@/annotations/model";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useSettings } from "@/hooks/use-settings";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { getPluginComposerBridge } from "../composer/api";
import type { ComposerController } from "../composer/controller";
import { PluginInstallationProvider } from "../installation-provider";
import { resolvePluginPlatform } from "../platform";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import type { InstalledPlugin } from "../types";

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

interface AnnotationPillProps {
  serverId: string;
  controller: ComposerController;
  attachment: AnnotationAttachment;
  disabled: boolean;
  index: number;
  onRemove(index: number): void;
  onChangeNote(id: string, note: string): void;
  onFocusComposer(): void;
}

function DefaultAnnotationPill(props: AnnotationPillProps) {
  return (
    <AnnotationPill
      attachment={props.attachment}
      disabled={props.disabled}
      index={props.index}
      onRemove={props.onRemove}
      onChangeNote={props.onChangeNote}
      onFocusComposer={props.onFocusComposer}
    />
  );
}

function PluginRenderedAnnotation({
  plugin,
  Component,
  pill,
  theme,
}: {
  plugin: InstalledPlugin;
  Component: ComponentType<PluginAttachmentRendererProps>;
  pill: AnnotationPillProps;
  theme: PluginTheme;
}) {
  const { controller, attachment, disabled, index } = pill;
  const renderFallback = useCallback(() => <DefaultAnnotationPill {...pill} />, [pill]);
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const hostLabel =
    hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId;
  const host = useMemo(() => ({ id: plugin.serverId, label: hostLabel }), [hostLabel, plugin]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const stateSource = useMemo(() => createPluginClientStateSource(plugin.serverId), [plugin]);
  const toast = useToast();
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const goesToSource = !compact && !isNative;
  const openSource = useCallback(() => {
    if (!goesToSource) return;
    goToSentAnnotationSource(attachment, {
      preferences: openInSidePane,
      onNotice: (message) => toast.show(message, { variant: "warning" }),
    });
  }, [attachment, goesToSource, openInSidePane, toast]);
  const composer = getPluginComposerBridge(plugin).handleFor(controller);
  const pluginAttachment = useMemo<PluginComposerAttachment | null>(() => {
    const { source, id, quote, note } = attachment;
    const { serverId: _serverId, ...pluginSource } = source;
    return { kind: "annotation", id, quote, note, source: pluginSource };
  }, [attachment]);
  if (!composer || !pluginAttachment) return renderFallback();
  const props: PluginAttachmentRendererProps = {
    theme,
    host,
    layout,
    attachment: pluginAttachment,
    index,
    composer,
    disabled,
    openSource,
  };
  return (
    <SurfaceErrorBoundary
      installation={plugin}
      resetKey={attachment}
      Surface={Component}
      renderError={renderFallback}
    >
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={stateSource}>
          <Component {...props} />
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedPluginRenderedAnnotation = withUnistyles(PluginRenderedAnnotation);

/**
 * A composer annotation: the first plugin renderer on this host draws it, and the default pill
 * stands in when none is installed or the renderer throws.
 */
export function PluginAnnotationAttachment(props: AnnotationPillProps) {
  const installed = useInstalledPlugins();
  const match = useMemo(() => {
    for (const plugin of installed) {
      if (plugin.serverId !== props.serverId) continue;
      const renderer = plugin.attachmentRenderers.find((entry) => entry.kind === "annotation");
      if (renderer) return { plugin, renderer };
    }
    return null;
  }, [installed, props.serverId]);
  if (!match) return <DefaultAnnotationPill {...props} />;
  return (
    <ThemedPluginRenderedAnnotation
      plugin={match.plugin}
      Component={match.renderer.Component as ComponentType<PluginAttachmentRendererProps>}
      pill={props}
      uniProps={pluginThemeMapping}
    />
  );
}
