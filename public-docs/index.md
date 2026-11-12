---
title: Getting started
description: Install Pimi and start running coding agents from anywhere.
nav: Getting started
order: 1
category: Getting started
---

# Getting started

Pimi is an agentic development environment for running coding agents, editing files, reviewing changes, and testing your work. Agents run on your machines; desktop, mobile, web, and CLI clients let you work from anywhere. Choose how to install it below.

## Desktop app (recommended)

Download from [Pimi downloads](https://1ikeadragon.github.io/pimi/) or the [GitHub releases page](https://github.com/1ikeadragon/pimi-releases/releases). Open it and you're done.

The desktop app bundles its own daemon and starts it automatically, no separate install required. On first launch you'll see a brief startup screen, then connect from your phone using **Settings → your host → Pair Device**.

## Server / CLI

For headless machines, dev boxes, or any setup where you want the daemon running without the desktop UI:

```bash
npm ci
npm run setup
npm run build:server
./packages/cli/bin/pimi
```

Pimi starts the daemon locally, then asks whether to enable the end-to-end encrypted relay and print a pairing QR code. If you decline, enter the daemon address manually over TCP, Tailscale, or another VPN.

Configuration and local state live under `PIMI_HOME` (defaults to `~/.pimi`).

## Where next

- [Run parallel tasks](/docs/parallel-development), use separate worktrees, review diffs, and test changes in the desktop app.
- [Connectivity](/docs/connectivity), connect through the relay or Tailscale.
- [Workspaces](/docs/workspaces), the project, workspace, and session model Pimi is built around.
- [Providers](/docs/providers), what a provider is and how Pimi wraps existing CLIs.
- [Orchestration](/docs/orchestration), let one agent delegate work to other providers and models.
- [Plugins](/docs/plugins), add trusted local surfaces, sidebar actions, daemon behavior, and composer attachments.
- [CLI reference](/docs/cli), every command.
- [GitHub repo](https://github.com/1ikeadragon/pimi-releases)
- [Report an issue](https://github.com/1ikeadragon/pimi-releases/issues)

## Prerequisites

Pimi manages other agents, it doesn't ship one. Before it's useful, install at least one provider CLI yourself and make sure it works with your credentials. See [Supported providers](/docs/supported-providers) for the full list.

You'll also want the [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated, Pimi uses it for PR-aware worktrees and a few orchestration features.
