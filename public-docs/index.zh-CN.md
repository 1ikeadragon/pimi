---
title: 快速上手
description: 安装 Pimi，随时随地运行编程 Agent。
nav: 快速上手
---

# 快速上手 {#getting-started}

Pimi 是一个 Agent 开发环境，用于运行编程 Agent、编辑文件、审查改动和测试你的工作。Agent 运行在你的机器上；桌面端、移动端、网页端和 CLI 客户端让你随时随地工作。在下面选择安装方式。

## 桌面应用（推荐） {#desktop-app-recommended}

从 [Pimi downloads](https://1ikeadragon.github.io/pimi/) 或 [GitHub releases 页面](https://github.com/1ikeadragon/pimi/releases)下载。打开即可使用。

桌面应用自带 daemon 并会自动启动它，无需单独安装。首次启动时你会看到一个简短的启动画面，之后在手机上通过 **设置 → 你的主机 → 配对设备** 连接。

## 服务器 / CLI {#server--cli}

适用于无界面的机器、开发机，或任何你想在没有桌面界面的情况下运行 daemon 的场景：

```bash
npm ci
npm run setup
npm run build:server
./packages/cli/bin/pimi
```

Pimi 会在本地启动 daemon，然后询问是否启用端到端加密中继并打印配对二维码。如果你拒绝，可以通过 TCP、Tailscale 或其他 VPN 手动输入 daemon 地址。

配置和本地状态位于 `PASEO_HOME` 下（默认为 `~/.paseo`）。

## 接下来 {#where-next}

- [运行并行任务](/docs/parallel-development)：在桌面应用中使用独立的 worktree、审查 diff 并测试改动。
- [连接](/docs/connectivity)：通过中继或 Tailscale 连接。
- [工作区](/docs/workspaces)：Pimi 所围绕的项目、工作区和会话模型。
- [Provider](/docs/providers)：什么是 Provider，以及 Pimi 如何封装现有 CLI。
- [编排](/docs/orchestration)：让一个 Agent 把工作委派给其他 Provider 和模型。
- [插件](/docs/plugins)：添加受信任的本地界面、侧边栏操作、daemon 行为和 Composer 附件。
- [CLI 参考](/docs/cli)：所有命令。
- [GitHub 仓库](https://github.com/1ikeadragon/pimi)
- [报告问题](https://github.com/1ikeadragon/pimi/issues)

## 前置条件 {#prerequisites}

Pimi 管理其他 Agent，本身并不附带 Agent。要让它发挥作用，请先自行安装至少一个 Provider CLI，并确认它能使用你的凭据正常工作。完整列表见[支持的 Provider](/docs/supported-providers)。

你还需要安装并认证 [GitHub CLI](https://cli.github.com/)（`gh`）。Pimi 用它实现感知 PR 的 worktree 和一些编排功能。
