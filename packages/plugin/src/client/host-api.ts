import type { JsonValue } from "@pimi/protocol/agent-types";
import type { PimiApi } from "@pimi/client";
import type { PluginClientOpenPanelOptions, PluginOpenScreenInput } from "./contracts.js";

/**
 * Hooks every plugin component can call: screens, settings, panels, overrides, and slots. The
 * app supplies the implementations; they read live app state and re-render on change.
 */

export interface PluginProjectSnapshot {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly kind: "git" | "non_git" | "directory";
}

export interface PluginActiveContext {
  /** The host the user is looking at; null on screens that belong to no host. */
  readonly serverId: string | null;
  readonly workspaceId: string | null;
  /** The agent whose chat is open, when one is. */
  readonly agentId: string | null;
  /** The current route's path, for example `/h/<serverId>/workspace/<id>`. */
  readonly pathname: string;
}

export interface PluginLayout {
  readonly compact: boolean;
  readonly platform: "ios" | "android" | "web";
  readonly isElectron: boolean;
  /** Window size in points; changes on resize and rotation. */
  readonly window: { readonly width: number; readonly height: number };
}

/** One row of an agent's visible chat, flattened for reading. */
export interface PluginTimelineEntry {
  readonly id: string;
  readonly kind: string;
  /** The message or summary text; null for kinds without text. */
  readonly text: string | null;
  readonly timestamp: number;
}

export type PluginQueryState<Data> =
  | { status: "loading"; data: Data | null; error: null; refetch(): void }
  | { status: "error"; data: Data | null; error: string; refetch(): void }
  | { status: "ready"; data: Data; error: null; refetch(): void };

export type PluginGitStatus = Awaited<ReturnType<PimiApi["git"]["status"]>>;
export type PluginGitDiff = Awaited<ReturnType<PimiApi["git"]["diff"]>>;
export type PluginGitCommits = Awaited<ReturnType<PimiApi["git"]["commits"]>>;
export type PluginGitDiffCompare = Parameters<PimiApi["git"]["diff"]>[1];

/** Client-owned navigation, available as `useNavigation()` and `client.navigation`. */
export interface PluginNavigation {
  openWorkspace(input: { workspaceId: string; serverId?: string }): void;
  openAgent(input: { agentId: string; serverId?: string }): void;
  /** Opens a file in the workspace's editor, optionally at a 1-based line. */
  openFile(input: { workspaceId: string; path: string; line?: number; serverId?: string }): void;
  /** Opens the workspace's working diff, optionally focused on one file. */
  openDiff(input: { workspaceId: string; path?: string; serverId?: string }): void;
  /** Opens one of this plugin's screens. */
  openScreen(input: PluginOpenScreenInput): void;
  /** Opens one of this plugin's settings screens. */
  openSettings(id: string): void;
  openPanel(id: string, options: PluginClientOpenPanelOptions): void;
  back(): void;
}

/**
 * Per-plugin, per-device JSON storage on the client. Survives restarts; never leaves the device.
 * For data the daemon owns, use `server.storage`.
 */
export interface PluginClientStorage {
  get<Value extends JsonValue = JsonValue>(key: string): Promise<Value | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}
