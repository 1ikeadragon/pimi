import type { ComponentType } from "react";
import {
  Bot,
  Brain,
  FilePenLine,
  FileText,
  Globe,
  MicVocal,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react-native";
import type { AgentMessage } from "@pimi/protocol/agent-message";
import type { ToolCallDetail } from "@pimi/protocol/agent-types";
import { PimiLogo } from "@/components/icons/pimi-logo";
import { resolveToolCallIconName, type ToolCallIcon } from "./tool-call-icon-name";

export type ToolCallIconComponent = ComponentType<{ size?: number; color?: string }>;

const ICON_COMPONENTS: Record<ToolCallIcon, ToolCallIconComponent> = {
  wrench: Wrench,
  square_terminal: SquareTerminal,
  eye: FileText,
  pencil: FilePenLine,
  file_text: FileText,
  file_pen_line: FilePenLine,
  globe: Globe,
  plug: Plug,
  search: Search,
  bot: Bot,
  sparkles: Sparkles,
  brain: Brain,
  mic_vocal: MicVocal,
  pimi: PimiLogo,
};

export function componentForToolCallIcon(name: ToolCallIcon): ToolCallIconComponent {
  return ICON_COMPONENTS[name];
}

export function resolveToolCallIcon(
  toolName: string,
  detail?: ToolCallDetail,
  agentMessage?: AgentMessage,
): ToolCallIconComponent {
  return componentForToolCallIcon(resolveToolCallIconName(toolName, detail, agentMessage));
}
