---
title: Hub quickstart
description: Connect Pimi to a compatible Hub you already run.
nav: Quickstart
order: 61
category: Hub
---

# Hub quickstart

With Pimi running and a compatible Hub available, log in from the machine that runs your daemon.

```sh
pimi hub login https://hub.example.com
```

Use your Hub's actual URL and approve the login in the browser. Choose whether to connect the daemon. Only grant `hub.execute` if you want Hub workflows to create workspaces and run agents.

To scaffold a starter trigger from your repository, run `pimi hub init` and select your Hub and trigger connection. Follow [Daemon connections](./daemons.md) to review or revoke access.
