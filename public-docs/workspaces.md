---
title: Chats and workspaces
description: Understand how Pimi groups working directories, agents, terminals, and browsers into chats, and the workspace behind each chat.
nav: Chats and workspaces
order: 10
category: Workspaces
---

# Chats and workspaces

Pimi is organized around projects and chats. Each chat is a task in a project.

Behind every chat is a **workspace**: the environment where the task happens. It has a working directory and can contain multiple sessions running at the same time. In the app, each session opens as a tab. The app, CLI, and MCP tools use two words for the same thing: the app says **chat**, while the CLI and MCP tools say **workspace** (`pimi workspace create`, `create_workspace`).

## Projects contain chats

The sidebar starts with projects. A project can be a git repository, a GitHub project, or any directory on a machine running the Pimi daemon.

Inside each project are chats. Each row is a chat, labeled with its title and, when it uses a worktree, its branch. For example:

```
my-app
├── main
├── fix-login-flow
└── redesign-settings
```

Each chat is a separate place to work. You can keep one for your main checkout, start another for a feature, or open a GitHub PR as another chat. Use **New chat** and choose whether it runs in the project folder or in a new worktree.

Use the [CLI project commands](/docs/cli#projects) to register, list, rename, or delete projects.

## Chats contain sessions

Agents run inside a chat's workspace as sessions. A chat can have one agent session, several agent sessions, terminals, browsers, and diffs open at the same time. Extra agent chats opened in the same workspace show as sibling rows in the sidebar, and subagents nest under the chat that started them.

That matters because real development rarely fits into one long conversation. You might ask one agent to implement a feature, open a terminal to run a service, start another agent to review the diff, and keep the browser open next to both. Those belong together because they are all part of the same task.

In Pimi, the chat is the stable container. The sessions are what you run inside it.

Rename a chat from the sidebar, the chat header, or the Command Center. Archiving a chat archives its workspace, so if other chats share the same worktree, the confirmation tells you how many other chats it also archives.

## Choose the isolation

Every chat has an isolation mode:

- **Local** uses an existing directory, such as your main checkout. Use it when sessions should share the files already on disk.
- **Worktree** creates or opens a managed git worktree. Use it when a task needs its own directory and branch.

A git worktree is one way to isolate a chat's files. More than one workspace can refer to the same managed worktree, and Pimi removes that worktree after its last workspace is archived.

## Creating a chat or workspace

For a desktop walkthrough from starting parallel agents to reviewing and testing their changes, see [Run parallel tasks](/docs/parallel-development).

You can start a chat in the app, or create a workspace from the CLI:

```bash
pimi workspace create --isolation local --path ~/dev/my-app --title main
pimi workspace create --isolation worktree --path ~/dev/my-app --base origin/main
```

You can also create a workspace without starting an agent right away. It is still there with its working directory ready; you can open terminals, run services, or browse files, then start an agent later.

Either way, once the workspace exists you can add more sessions to it. Open a terminal alongside an agent, start a second agent to review changes, or open a browser tab to check a local service. Every session lives as a tab inside the same chat.

Creating an agent and creating a workspace are separate actions. Pass a workspace ID when you want an agent in a specific existing workspace. A bare `pimi run` from a human shell creates a new local workspace; when one agent runs it, Pimi recognizes the caller and creates a subagent in the caller's workspace.

## Worktrees

Every chat in Pimi is backed by a working directory. When that directory is a git worktree, you get a separate branch and isolated environment for each task.

If you want the details on configuring setup hooks, scripts, and services, continue to [Git worktrees](/docs/worktrees).
