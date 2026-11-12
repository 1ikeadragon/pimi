---
title: 在 CLI 中使用自动化
description: 用 pimi automation 和 pimi heartbeat 创建和管理 Pimi 自动化与 heartbeat。
nav: CLI
---

# 在 CLI 中使用自动化 {#automations-from-the-cli}

`pimi automation` 在终端中创建和管理[自动化](/docs/automations)，适用于无界面的机器和脚本。每次运行都会启动一个新的 Agent。

## 创建 {#create}

`--name` 和 `--provider` 是必填项。传入 `--cron` 或 `--every` 设置计划；两者都不传时，该自动化只能手动运行。

在 Codex 上通宵重构，每次运行使用一个新的 worktree：

```bash
pimi automation create \
  --every 30m \
  --name overnight-refactor \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  --worktree \
  --max-runs 16 \
  --expires-in 10h \
  "Continue the refactor. Run the focused checks. Leave a short status note."
```

在 Claude 上检查构建：

```bash
pimi automation create \
  --every 10m \
  --name build-watch \
  --provider claude/opus-4.7 \
  --cwd ~/dev/my-app \
  --max-runs 24 \
  "Check the release build. If it failed, inspect logs, fix the cause, and rerun."
```

纽约时间早上 9 点进行晨间分拣，并跟随夏令时变化：

```bash
pimi automation create \
  --cron "0 9 * * 1-5" \
  --timezone America/New_York \
  --name morning-triage \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  "Review overnight CI failures and summarize anything urgent."
```

一个由你手动启动的自动化：

```bash
pimi automation create \
  --name release-notes \
  --provider claude \
  --cwd ~/dev/my-app \
  "Draft release notes from the commits since the last tag."
```

其他选项：`--mode <mode>`（默认为 Provider 的无人值守模式；没有该模式时使用其默认模式）、`--thinking <id>`。停在权限提示处的运行会失败。

在 Pimi Agent 内运行时，`create` 会创建一个 **pending** 自动化，等待你审批。在应用中审批，或在普通终端中运行 `pimi automation approve <id>`；Agent 不能审批。

## 管理 {#manage}

```bash
pimi automation ls
pimi automation inspect <id>        # 详情和最近的审计历史
pimi automation runs <id> --limit 5 # 运行记录，最新的在前
pimi automation run <id>            # 立即启动一次运行
pimi automation pause <id>
pimi automation resume <id>
pimi automation approve <id>
pimi automation rm <id>
```

要修改自动化，请在应用中编辑，或删除后重新创建。

## 节奏 {#cadence}

使用 `--cron "<expr>"` 指定 5 字段的 cron 表达式。`--every <duration>` 接受 `15m` 或 `1h` 这样的间隔，并把它们编译为 cron；cron 无法表示的间隔会被拒绝。它不会创建以创建时间为起点的滚动间隔。

节奏默认使用主机所在的时区，保存的节奏会记下这个时区。传入 `--timezone <IANA>` 可以按本地挂钟时区解释，例如 `--timezone America/New_York`，这样任务在夏令时变化前后都保持在相同的本地时间。

以远程 daemon 为目标时，用 `pimi --host <target> automation create ...` 开始命令。使用 `--host` 时必须传入 `--cwd`；你本地的工作目录在远程机器上可能不存在。

## heartbeat {#heartbeats}

heartbeat 会把一段提示词发回创建它的 Agent。在运行中的 Pimi Agent 内：

```bash
pimi heartbeat create \
  --every 20m \
  --name continue \
  "Check the current task state and continue with the next useful step."
```

只能指定一种节奏：

| 参数                              | 触发方式                      |
| --------------------------------- | ----------------------------- |
| `--cron "<expr>"`（`--timezone`） | 按 cron 节奏                  |
| `--every <duration>`              | 按间隔，至少 30 秒（`90s`）   |
| `--in <duration>`                 | 在一段延迟后触发一次（`20m`） |
| `--at <ISO 8601>`                 | 在该时间触发一次              |

一次性 heartbeat 只触发一次，之后会被删除；Agent 忙碌时它会等待。`--name` 是可选的，用已有的名称创建 heartbeat 会替换原来的。`--max-runs` 和 `--expires-in` 设置它何时结束。

```bash
pimi heartbeat update <id> --every 10m  # 修改触发时间
pimi heartbeat delete <id>
pimi heartbeat ls
```

`create` 必须在 Pimi Agent 内运行，Pimi 会在其中设置 `PIMI_AGENT_ID`。在 Agent 内，`update`、`delete` 和 `ls` 只作用于该 Agent 的 heartbeat；在 Agent 外，它们作用于主机上的全部 heartbeat，因此你可以按 id 停止或调整任何 heartbeat。`update` 只改变节奏。已归档 Agent 的 heartbeat 会被删除。
