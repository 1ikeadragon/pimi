import { PluginTranslationProvider, usePluginTranslationRuntime } from "./translations.js";
import { useCallback, type ReactNode } from "react";
import { PluginClientStateProvider, usePluginClientStateSource } from "./client-state.js";
import { PimiApiProvider, usePimiContextValue } from "./pimi-context.js";
import { PluginRpcProvider, usePluginRpcContextValue } from "./rpc-context.js";

export type PluginRuntimeContextBridge = (children: ReactNode) => ReactNode;

/** Rebuilds plugin runtime contexts inside React Native portal hosts. */
export function usePluginRuntimeContextBridge(): PluginRuntimeContextBridge {
  const translations = usePluginTranslationRuntime();
  const pimi = usePimiContextValue();
  const rpc = usePluginRpcContextValue();
  const state = usePluginClientStateSource();

  if (!pimi || !rpc) {
    throw new Error("Plugin UI must run inside a contributed plugin surface");
  }

  return useCallback(
    (children: ReactNode) => {
      const content = state ? (
        <PluginClientStateProvider source={state}>{children}</PluginClientStateProvider>
      ) : (
        children
      );
      return (
        <PimiApiProvider pimi={pimi}>
          <PluginRpcProvider invoke={rpc.invoke} subscribe={rpc.subscribe}>
            <PluginTranslationProvider runtime={translations}>{content}</PluginTranslationProvider>
          </PluginRpcProvider>
        </PimiApiProvider>
      );
    },
    [pimi, rpc, state, translations],
  );
}
