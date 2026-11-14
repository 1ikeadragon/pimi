---
title: Resources
description: What Settings > Resources shows, and what it cannot see.
nav: Resources
order: 40
category: Reference
---

# Resources

Settings > Resources lists the processes Pimi runs with their CPU and memory, and the network connections those processes hold.

## Limits

- Connections are sampled. One that opens and closes between two samples is not seen. Samples run every 2 seconds while the tab is open, every 3 seconds while an agent or terminal job runs, and every 10 seconds otherwise.
- Programs started by agents and terminals show an IP address unless Pimi can match it to a name. Names come from the daemon's own lookups and from a forward lookup of known hosts. Shared cloud addresses can belong to more than one site.
- Only the trees Pimi owns are sampled: the daemon and what it starts, terminal programs, and the desktop app. A program that leaves its tree before the first sample, or runs under another user, is not seen.
- UDP is seen only for connected sockets. DNS queries made by child programs are not seen.
- Nothing inside a connection is read. A known host can still carry data you did not intend to send.
- This is a view, not a firewall. Code running as your user can change what the daemon records.
- Windows and Linux hosts use different readers than macOS and have had less testing.

## New and known

A destination is known when its name matches Pimi's built-in list, it is on your private network, or you chose Trust. Everything else is listed under New. Trust is remembered in `network-baseline.json` in the Pimi home folder. Reset clears it.

## Logs

New connections are written to the network log with the program and process id. Logs follow the Days setting.
