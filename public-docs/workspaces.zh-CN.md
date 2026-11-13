---
title: 聊天与工作区
description: 了解 Pimi 如何把工作目录、Agent、终端和浏览器组织成聊天，以及每个聊天背后的工作区。
nav: 聊天与工作区
---

# 聊天与工作区 {#workspaces}

Pimi 围绕项目和聊天组织。每个聊天是项目中的一个任务。

每个聊天背后都有一个**工作区**：任务发生的环境。它有一个工作目录，可以同时包含多个正在运行的会话。在应用中，每个会话以一个标签页打开。应用、CLI 和 MCP 工具对同一事物使用两个词：应用中称为**聊天**，CLI 和 MCP 工具称为**工作区**（`pimi workspace create`、`create_workspace`）。

## 项目包含聊天 {#projects-contain-workspaces}

侧边栏从项目开始。项目可以是一个 git 仓库、一个 GitHub 项目，或者运行 Pimi daemon 的机器上的任意目录。

每个项目中都有聊天。每一行是一个聊天，以其标题标注；如果使用 worktree，还会显示分支。例如：

```
my-app
├── main
├── fix-login-flow
└── redesign-settings
```

每个聊天都是一个独立的工作场所。你可以为主检出保留一个，为某个功能再新建一个，或者把一个 GitHub PR 作为另一个聊天打开。使用**新建聊天**，并选择在项目文件夹中运行还是在新的 worktree 中运行。

使用 [CLI 项目命令](/docs/cli#projects)注册、列出、重命名或删除项目。

## 聊天包含会话 {#workspaces-contain-sessions}

Agent 以会话的形式在聊天的工作区中运行。一个聊天可以同时打开一个或多个 Agent 会话，以及终端、浏览器和 diff。在同一工作区中打开的其他 Agent 聊天会作为同级行显示在侧边栏中，子 Agent 则嵌套在启动它们的聊天之下。

这一点很重要，因为真实的开发很少能装进一段长长的对话。你可能让一个 Agent 实现某个功能，打开一个终端运行服务，再启动另一个 Agent 审查 diff，同时在旁边开着浏览器。它们都属于同一个任务，所以应该放在一起。

在 Pimi 中，聊天是稳定的容器，会话是你在其中运行的东西。

可以在侧边栏、聊天标题栏或命令中心重命名聊天。归档聊天会归档其工作区，因此如果其他聊天共用同一个 worktree，确认对话框会告诉你还会同时归档多少个其他聊天。

## 选择隔离方式 {#choose-the-isolation}

每个聊天都有一种隔离模式：

- **本地** 使用一个现有目录，例如你的主检出。当会话应该共享磁盘上已有的文件时使用。
- **新建 worktree** 创建或打开一个受管理的 git worktree。当任务需要自己的目录和分支时使用。

git worktree 是隔离聊天文件的一种方式。多个工作区可以指向同一个受管理的 worktree，Pimi 会在最后一个引用它的工作区被归档后删除该 worktree。

## 创建聊天或工作区 {#creating-a-workspace}

关于从启动并行 Agent 到审查和测试其改动的桌面端完整流程，请参见[运行并行任务](/docs/parallel-development)。

你可以在应用中新建聊天，或通过 CLI 创建工作区：

```bash
pimi workspace create --isolation local --path ~/dev/my-app --title main
pimi workspace create --isolation worktree --path ~/dev/my-app --base origin/main
```

你也可以创建工作区而不立即启动 Agent。它及其工作目录依然就绪；你可以打开终端、运行服务或浏览文件，稍后再启动 Agent。

无论哪种方式，工作区创建后都可以向其中添加更多会话。在 Agent 旁边打开一个终端，启动第二个 Agent 审查改动，或打开一个浏览器标签页检查本地服务。每个会话都是同一个聊天中的一个标签页。

创建 Agent 和创建工作区是两个独立的操作。如果你想让 Agent 位于某个已有的工作区，请传入工作区 ID。在人工操作的 shell 中直接运行 `pimi run` 会创建一个新的本地工作区；当某个 Agent 运行它时，Pimi 会识别调用者，并在调用者的工作区中创建一个子 Agent。

## Worktree {#worktrees}

Pimi 中的每个聊天都由一个工作目录支撑。当这个目录是 git worktree 时，每个任务都会获得独立的分支和隔离的环境。

如果想了解配置 setup 钩子、脚本和服务的细节，请继续阅读 [Git worktree](/docs/worktrees)。
