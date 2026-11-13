# Desktop target

Attack mode can drive one desktop window instead of (or beside) a URL. The owner picks the window; agents get `desktop_*` tools that see and act inside it and nowhere else. macOS and Windows are supported; Linux answers `unsupported`.

## Layers

| Layer        | Where                                                 | Owns                                                                                                         |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Agent tools  | `packages/server/src/server/desktop-tools/tools.ts`   | Tool schemas and descriptions, the input-consent check (`INPUT_VERBS`), result text                          |
| Guard        | `AttackService.desktopGuardForAgent`                  | Builds the guard from the run record. An agent never supplies one                                            |
| Broker       | `desktop-tools/broker.ts`                             | Routes a request to the connected desktop app and waits for the answer                                       |
| Wire schema  | `packages/protocol/src/desktop-target/rpc-schemas.ts` | Commands, results, error codes, guard                                                                        |
| Main process | `packages/desktop/src/features/desktop-target/`       | Applies the guard again, then runs the command through the platform's `pimi-desktop-helper` (`mac/`, `win/`) |
| Helper       | `packages/desktop/native/win/`, `native/mac/`         | Accessibility or UI Automation, window capture, input injection, the gates that keep input inside the window |

The daemon and the main process both check the guard. The daemon refuses before sending, the main process refuses again, and the Windows helper checks a third time. Keep all three when you add a verb.

## The target and the guard

The wire field is `bundleId` on both platforms. On Windows it holds the app id: the AUMID of a packaged app, otherwise the lowercased full exe path. `platform` and, on Windows, `win` (`hwnd`, `pid`, `processStartedAt`, `windowClass`, `exeName`, `framework`) come from the picker's `list_windows` item and travel with the run.

The handle in `win` is a hint. Every helper call checks it against the process identity and, when it is dead, looks for the app's one window again. The main process keeps a per-run pin map and updates it when the helper answers `repinned`. More than one window of the app fails with `refused` instead of guessing.

The owner's consent switches are separate: `allowDesktopInput` (also implied by a disposable target) for input, `allowRelaunch` for `desktop_app launch` and `relaunch`. Launch arguments are typed by the owner in the launch form and never by the agent.

## Platform differences an agent must be told

|                | macOS                                                                                       | Windows                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Element id     | ref such as `@d12` from a snapshot or `desktop_find`                                        | ref such as `@d12` from a snapshot, `desktop_find` or a marked screenshot                     |
| Coordinates    | pixels of the latest screenshot (the helper remembers each agent's frame)                   | pixels of the latest screenshot (the helper remembers each agent's frame)                     |
| Tools          | snapshot, find, element, screenshot, window, wait, audit, app, deeplink and the input tools | all of them                                                                                   |
| Refused chords | `cmd+q`, `cmd+tab`, screenshots, space switching                                            | the Windows key, `alt+tab`, `alt+f4`, `ctrl+alt+<key>`, `alt+space`, `printscreen`, lock keys |
| Permissions    | Accessibility and Screen Recording, granted to the app that spawned the helper              | none; the permissions call returns granted                                                    |

The prompt block (`desktopBlock` in `packages/server/src/server/attack/prompts.ts`) says this per platform. Change both together.

macOS answers `unsupported` for the Windows-only verbs and ignores optional arguments it cannot honour.

## Deny lists

`win/guard-win.ts` holds the list of apps that are never targets (terminals, remote control, system tools, password managers, the shell, Pimi itself) and the Windows `refuseWinChord`. The helper has the same list and re-checks it. Edit both. Games that ship anti-cheat are listed in the picker as blocked and refused at resolve: synthesized input next to anti-cheat can get an account banned.

## macOS helper

- `native/mac/*.swift`, built with `swiftc` and Apple frameworks only (`npm run build:mac-helper`, arm64, macOS 13+). No SwiftPM, no packages. `npm run pimi:package:mac` and the release workflow build it first.
- Same process model as the Windows helper: `helper-process.ts` spawns it lazily and speaks JSON lines. On a timeout the main process sends SIGTERM and then SIGKILL 700 ms later, so the helper can release held keys and buttons.
- Screen Recording and Accessibility are granted to the app that spawned the helper (Pimi packaged; Electron or the terminal in dev), not to the helper. `pimi-desktop-helper --selftest` prints both states for the process it runs under, so run it from a terminal only to see the terminal's grants.
- The window is pinned by its window-server id, owner pid and process start time (carried in the picker's `win`, with the id in `hwnd`). The helper falls back to the app's one window and answers `repinned`.
- Capture is ScreenCaptureKit on macOS 14+ (the window plus the menus, popovers and sheets of the same app that sit on it), with `screencapture -l <id>` as the fallback on macOS 13 and when ScreenCaptureKit fails; the result's `method` says which. Both read the window even when another window covers it. `grid`, `marks` and `region` are drawn and cropped in the helper with CoreGraphics; `marks` runs an interactive-only snapshot, so it needs Accessibility.
- `desktop_app`: `status` reads the pinned pid (alive and same start time), memory, CPU, whether Accessibility answers, and crash reports written to `~/Library/Logs/DiagnosticReports` since the start. `relaunch` asks the app to quit (`NSRunningApplication.terminate`), waits 3 s, force-quits only a disposable target, opens it again with the owner's launch arguments and pins its window. `launch` does nothing when a window is already open. More than one candidate window after a start fails with `refused`.
- `desktop_deeplink` opens the URL in the target app only (`NSWorkspace.open(_:withApplicationAt:)`). The scheme must be in the bundle's `CFBundleURLTypes`; otherwise the helper refuses and names the system's handler. The main process also refuses web, file, mail and Apple-owned schemes.
- Menu bar: `snapshot` ends with the app's top-level menu items (not the Apple menu) as refs. `click` on a menu ref is `AXPress` only (left, once, no modifiers) and never moves the cursor; points in the menu bar are refused by the hit test. Items named Quit, Hide, Hide Others, Close All, Log Out, Shut Down, Restart, Sleep or Lock Screen (English names), and items whose key equivalent is a chord `Safety.refusal` denies (cmd+q, cmd+h, cmd+w, cmd+m ...), are refused with their `refused` attribute shown in the tree.

## Windows helper

- Spawned lazily by `win/helper-process.ts`, JSON lines on stdin and stdout, one request at a time. A request that takes longer than 10 s (15 s for `wait`, 25 s for `app launch`) kills the helper; the next request starts a new one. The helper releases every key it holds when it dies.
- Dev builds read `packages/desktop/native/win/bin`; packaged builds read `resources/desktop-helper`. Build it with `npm run build:win-helper` (needs the .NET SDK). `npm run pimi:package:win` runs that first and the release workflow runs `--selftest` on the packaged exe.
- Real input needs the target in the foreground. Input that would land elsewhere fails with `occluded`, `foreground_denied`, `user_active` or `elevated_target` rather than reaching another window. Capture uses Windows.Graphics.Capture first, then `PrintWindow`, then a screen grab; a result with `suspectBlank` means every method returned a dark or flat frame.
- Games and custom-drawn UIs have no accessibility tree. The agent uses `screenshot` with `grid`, clicks coordinates, holds keys with `holdMs` and turns the camera with `desktop_mouse move_rel`.

## Findings

`submit_finding` takes `desktopScreenshot: true` to attach a fresh screenshot of the run's window as evidence. The shot goes through the same broker `screenshot` command on both platforms. `desktopHighlight` (a rectangle in screenshot pixels) is written into the evidence caption; the image itself is not drawn on.

## Verifying a change

Use the dev desktop app with a checkout-local `PIMI_HOME` ([development](development.md)); never the installed Pimi's daemon on port 6767. Pimi itself is a good Electron target and Notepad a good Win32 and WinUI one. Never drive terminals, chat clients or anti-cheat games. See [testing](testing.md) for the real-app bar.
