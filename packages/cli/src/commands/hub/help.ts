import type { Command } from "commander";

const resolutionHelp =
  "\nHub origin precedence: command origin/--hub, PIMI_HUB_URL, then active stored login.\nCredential precedence: --api-key, PIMI_HUB_API_KEY, then a stored login for the exact resolved origin.\n";

export function addHubResolutionHelp(command: Command): Command {
  return command.addHelpText("after", resolutionHelp);
}
