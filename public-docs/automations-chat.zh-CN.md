---
title: 在聊天中创建自动化
description: 在聊天中让 Agent 为你创建自动化或 heartbeat。
nav: 聊天
---

# 在聊天中创建自动化 {#automations-from-chat}

在任意 Agent 聊天中提出要求，Agent 就会通过 [Pimi MCP](/docs/mcp#automations-and-heartbeats) 为你创建自动化。

示例提示词：

- “每个工作日早上 9 点，分拣新的 GitHub issue 和 PR，并总结需要关注的内容。”
- “每 10 分钟检查一次发布构建；如果失败，就修复原因。”
- “继续做这次重构：每 20 分钟唤醒自己一次，从上次停下的地方接着做。”

Agent 会根据你的要求选择节奏和提示词。新的 Agent 使用与你提问的 Agent 相同的 Provider、模型、模式和 thinking 设置，除非你指定了 Provider。没有节奏时，该自动化只能手动运行。

Agent 创建的自动化会保持 **pending**，直到你在[自动化页面](/docs/automations#approval)中或用 `pimi automation approve <id>` 审批。Agent 不能审批它。

审批之后，Agent 可以列出、查看、暂停自动化并启动运行，也可以删除自己创建且仍在等待审批的自动化。要恢复、编辑或删除已审批的自动化，请使用应用或 [CLI](/docs/automations-cli)。

## heartbeat {#heartbeats}

Agent 安排稍后唤醒自己，称为 **heartbeat**。提示词会发回同一个 Agent 和同一段对话，可以按 cron 节奏或固定间隔重复触发，也可以在一段延迟后或某个时间点触发一次。周期性 heartbeat 如果在 Agent 忙碌时触发，该次会失败；一次性 heartbeat 会等到 Agent 空闲。heartbeat 不需要审批；Agent 可以创建、列出和删除自己的 heartbeat。要修改 heartbeat，请让 Agent 删除它并创建一个替代的。
