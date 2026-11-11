# QA

QA is the main bottleneck of Pimi's product development.

The bar is four questions:

1. Does it work well?
2. Does it regress anything else?
3. Was it tested on every platform it affects?
4. Did you run the real flow, and does the evidence show it?

Every pull request needs evidence for the questions its change touches. Pull requests without evidence get closed.

For plugin changes, verify the [SDK import boundaries](plugins.md#sdk-import-boundaries) before
exercising contributions. Include both runtime loaders in the evidence.

## Evidence

Evidence is something someone else can look at:

- The commands you ran, pasted with their output
- Before and after screenshots
- A video of the interaction
- Logs, requests, responses

Redact what you need to, keep the technical details. If an agent did the work, submit its raw output. A summary drops the details someone else needs to check it.

## Does it work well

A feature that works but stutters, shifts the layout, or misaligns by two pixels is not done.

For UI, that means matching the design system in visuals, in interaction, and in performance. [design.md](design.md) is the reference.

The two things that go wrong most often:

- **Layout shift.** Content that jumps as data arrives, a row that resizes when a badge appears, a panel that reflows on first render. Watch the change on a slow connection and on first load, not just after everything is warm.
- **Alignment.** Things align to their glyphs, not to their touch targets. See the alignment rules in [design.md](design.md).

## Does it regress anything else

Pimi is composable by design, which means your change sits next to features you didn't touch. Open the surfaces around it. A change to the agent list affects archive, subagents, and tabs; a change to git actions affects worktrees and the checkout flow.

Performance is part of this. The app is Expo React Native, not a web app in a native shell. You are not writing CSS, styles resolve differently, and performance characteristics differ per platform. What feels instant in a desktop dev build can be visibly slow on a phone.

If your change touches a hot path such as the terminal, the message list, or git polling, submit before and after numbers. [terminal-performance.md](terminal-performance.md) has the terminal pipeline and its benchmarks, and [development.md](development.md) covers renderer and React profiling.

## Every platform it affects

Your code does not only run on the platform you tested it on. The same app ships to iOS, Android, browser web, and Electron on macOS and Windows, and the daemon runs on both desktop operating systems.

You aren't expected to own every device. You are expected to say what you covered:

| Platform        | Tested | Notes |
| --------------- | ------ | ----- |
| iOS             |        |       |
| Android         |        |       |
| Web             |        |       |
| Desktop macOS   |        |       |
| Desktop Windows |        |       |

Install what you reasonably can. An iOS simulator and an Android emulator cover most of the gap on a single machine, see [development.md](development.md) and [android.md](android.md).

For the rules about which code runs where, read the platform gating section in [CLAUDE.md](../CLAUDE.md). The recurring traps have their own docs: [hover.md](hover.md), [unistyles.md](unistyles.md), [floating-panels.md](floating-panels.md), [mobile-panels.md](mobile-panels.md), [expo-router.md](expo-router.md).

The app and daemon ship together, so test a change with both built from the same commit: [protocol-compatibility.md](protocol-compatibility.md).

## Real-app evidence

There is no automated test suite, so evidence comes from running the real flow. [testing.md](testing.md) says how: the dev daemon, the desktop and app dev servers, the CLI, and the packaged-app smoke.

- Walk the flow with real inputs, not fixtures, and say which steps you ran.
- A bug fix needs the original reproduction, run before and after your change.
- Agent provider work needs a run against the real provider by someone who can tell that it worked.
- Failure paths need a real failure: stop the daemon, send a bad input, drop the connection.

Show the result as commands with their output, screenshots, video, or logs. For Electron screenshots, see [browser-capture-harness.md](browser-capture-harness.md).
