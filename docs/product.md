# Product

Pimi is a desktop workspace for running coding agents, tracking their work, and reviewing changes across repositories.

## The core workflow

Each project holds chats; a chat is one unit of work with its agents, terminals, files, and browser tabs, running in the project folder or its own worktree. Start a chat with a supported harness. Tasks is a to-do list: add one yourself, or ask an agent in a chat to, and the chat is linked to it. Labels from one shared catalog tag chats, subagents and tasks, and the sidebar filters by them. Agent Grid shows those chats together. Review brings file browsing, pull requests, and worktree diffs into one place.

Memory gives providers shared project notes. Spaces holds links, images, and notes you can refer to by card ID. Automations run prompts on a schedule. Usage shows provider limits and a history of tokens and estimated cost across Claude Code and Codex sessions, including ones run outside Pimi, and Recap lists the tasks you completed.

## Local setup and remote access

The desktop app manages its local daemon. Agents run on the machine that hosts the daemon using that machine’s files and harness credentials. You can also connect to a daemon on another host. See the [architecture guide](architecture.md) for the client, daemon, and relay boundaries.

The daemon, CLI, relay, and plugin APIs build on Pimi. See [Credits](../README.md#credits) and [the Apache license](../LICENSE). [The plugin guide](plugins.md) covers extensions.
