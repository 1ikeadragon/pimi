---
title: 自动化
description: 按计划或手动用一段提示词运行新的 Agent，或用 heartbeat 唤醒已有的 Agent。
nav: 概览
---

# 自动化 {#automations}

自动化会在一个项目中用一段提示词启动一个新的 Agent。它可以按计划运行，也可以只在你手动运行时运行。每次运行的结果都在该次运行的 Agent 聊天中。

Pimi 还有 **heartbeat**。heartbeat 会把一段提示词发回一个已有的 Agent，让它继续同一段对话。heartbeat 由 Agent 自己管理，可以通过[聊天](/docs/automations-chat)或 [CLI](/docs/automations-cli#heartbeats) 创建，不会显示在自动化页面中。

## 用途 {#what-its-for}

- **周期性任务**：为每日分拣、报告或维护启动一个干净的 Agent。
- **盯构建**：按固定节奏检查 CI、EAS、Docker 或发布构建。
- **维护巡检**：更新依赖、审核文档或清理过期分支。
- **保存的提示词**：保留一个手动自动化，需要时手动运行。

## 在应用中创建 {#create-one-in-the-app}

在侧边栏打开 **Automations**，选择 **New automation**，或从 **Templates**（Weekday PR review、Weekly project digest）开始。表单包含：

- **Name**（必填）和 **Prompt**
- **Trigger**：**On a schedule** 并设置 **Cadence**，或 **Run by hand**
- 运行所在的 **Host** 和 **Project**
- Agent 的 **Model**、**Thinking** 和 **Mode**
- **Isolation**：**Local** 在项目目录中运行；**Worktree** 为每次运行创建一个新的 worktree
- **Max runs**：运行这么多次后结束该自动化

应用按你设备的时区解释节奏。之后要修改自动化，请在应用中编辑；CLI 和 Agent 工具不能更新自动化。

你也可以[在聊天中](/docs/automations-chat)、[通过 CLI](/docs/automations-cli) 或[通过 MCP](/docs/mcp#automations-and-heartbeats) 创建自动化。

## 审批 {#approval}

Agent 创建的自动化处于 **pending** 状态，显示在 **Needs your approval** 下。在你于应用中选择 **Approve**，或在普通终端中运行 `pimi automation approve <id>` 之前，它不会运行。Agent 不能审批自动化。

## 状态 {#status}

| 状态                  | 含义                                    |
| --------------------- | --------------------------------------- |
| Pending               | 由 Agent 创建，等待你审批。             |
| Active                | 按计划运行，或在你手动运行时运行。      |
| Paused                | 被你或 Agent 暂停；恢复后才会再次运行。 |
| Paused after failures | 连续三次运行失败。修复原因后再恢复。    |
| Ended                 | 达到最大运行次数或已过期，不会再运行。  |

## 限制 {#limits}

- 每次运行 60 分钟后超时。
- 每个自动化每小时最多运行 6 次，同时最多运行 2 次。
- daemon 同时最多运行 4 个自动化运行。多出来的计划运行会被跳过，并记录在审计日志中。
- daemon 停止期间错过的时间点会被跳过，不会补跑。

## 历史 {#history}

Pimi 为每个自动化保留最近 50 次运行（最多 30 天），以及记录每次变更的审计日志。`pimi automation runs <id>` 列出运行记录；`pimi automation inspect <id>` 显示最近的审计历史。

运行结束后，运行聊天会保留。像其他聊天一样归档它们即可。
