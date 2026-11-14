import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runArchiveCommand } from "./archive.js";
import { runCreateCommand } from "./create.js";
import { runLsCommand } from "./ls.js";
import { runRenameCommand } from "./rename.js";
import { runSetupCommand } from "./setup.js";

export function createChatCommand(): Command {
  const chat = new Command("chat").description("Manage chats");

  addJsonAndDaemonHostOptions(
    chat
      .command("setup")
      .description("Allow and run setup for a chat")
      .argument("<chat-id>", "Chat id"),
  ).action(withOutput(runSetupCommand));

  addJsonAndDaemonHostOptions(
    chat
      .command("create")
      .description("Create a chat")
      .requiredOption("--isolation <local|worktree>", "Chat isolation")
      .option("--path <path>", "Local directory or source checkout (default: current)")
      .option("--project <id>", "Existing project id")
      .option("--title <title>", "Chat title")
      .option(
        "--mode <mode>",
        "Worktree mode: branch-off, checkout-branch, or checkout-pr (default: branch-off)",
      )
      .option("--worktree-slug <slug>", "Managed worktree path slug")
      .option("--new-branch <name>", "New branch name (--mode branch-off)")
      .option("--base <ref>", "Base ref (--mode branch-off)")
      .option("--branch <name>", "Existing branch (--mode checkout-branch)")
      .option("--pr-number <n>", "Pull request or change request number (--mode checkout-pr)")
      .option("--forge <forge>", "Forge for --mode checkout-pr (default: source checkout)")
      .option("--background", "Create a background chat")
      .option("--no-background", "Create a visible chat instead of inheriting background"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    chat
      .command("ls")
      .description("List active chats")
      .option("--background", "Include background chats"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    chat
      .command("rename")
      .description("Set a chat's user-visible title")
      .argument("<chat-id>", "Chat id")
      .argument("[title]", "New chat title")
      .option("--reset", "Clear the title and revert to the branch or directory name")
      // Commander 12 accepts excess positionals by default, which would rename to
      // the first word of an unquoted multi-word title and silently drop the rest.
      .allowExcessArguments(false),
  ).action(withOutput(runRenameCommand));

  addJsonAndDaemonHostOptions(
    chat
      .command("archive")
      .description("Archive a chat and everything it owns")
      .argument("<chat-id>", "Chat id"),
  ).action(withOutput(runArchiveCommand));

  return chat;
}
