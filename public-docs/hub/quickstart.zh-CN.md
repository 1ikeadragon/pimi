---
title: Hub 快速开始
description: 将 Pimi 连接到已运行的兼容 Hub。
nav: 快速开始
order: 61
category: Hub
---

# Hub 快速开始

运行 Pimi 和兼容 Hub 后，在 daemon 所在机器上登录。

```sh
pimi hub login https://hub.example.com
```

将示例地址替换为 Hub 的实际地址，并在浏览器中确认登录。仅在需要 Hub 工作流创建工作区和运行代理时授予 `hub.execute`。

要创建起步触发器，可在仓库中运行 `pimi hub init`，然后选择 Hub 和触发器连接。有关查看或撤销权限，请参阅[连接 daemon](./daemons.zh-CN.md)。
