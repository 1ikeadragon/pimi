import { describe, expect, test } from "vitest";

import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
} from "@pimi/protocol/binary-frames/index";
import {
  createTerminalRestoreDelivery,
  resolveRestoreAfterOutputOverflow,
  resolveTerminalRestoreSnapshotOptions,
} from "./terminal-restore.js";

describe("terminal restore policy", () => {
  test("resolves restore snapshot options", () => {
    expect(resolveTerminalRestoreSnapshotOptions({ mode: "live" })).toBeNull();
    expect(resolveTerminalRestoreSnapshotOptions({ mode: "visible-snapshot" })).toEqual({
      scrollbackLines: 200,
    });
    expect(
      resolveTerminalRestoreSnapshotOptions({ mode: "visible-snapshot", scrollbackLines: 999 }),
    ).toEqual({ scrollbackLines: 999 });
  });

  test("bounds pressure recovery for every restore mode", () => {
    expect(resolveRestoreAfterOutputOverflow({ mode: "live" })).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 500,
    });
    expect(resolveRestoreAfterOutputOverflow({ mode: "full-snapshot" })).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 500,
    });
  });
});

test("projects chunked replay begin onto the declared wire metadata", () => {
  const frames: Uint8Array[] = [];
  const deliver = createTerminalRestoreDelivery({
    slot: 7,
    send: (frame) => {
      frames.push(frame);
    },
  });
  deliver({
    type: "begin",
    metadata: {
      rows: 30,
      cols: 120,
      retainedHistoryLines: 842,
      revision: 5123,
      replayPreamble: "\x1b[?2004h",
    },
  });
  const data = new TextEncoder().encode("\x1b[31m界 replay\x1b[0m");
  deliver({ type: "data", data });
  deliver({ type: "end" });
  const decoded = frames.map((frame) => decodeTerminalStreamFrame(frame)!);
  expect(decoded.map((frame) => ({ slot: frame.slot, opcode: frame.opcode }))).toEqual([
    { slot: 7, opcode: TerminalStreamOpcode.ReplayBegin },
    { slot: 7, opcode: TerminalStreamOpcode.ReplayData },
    { slot: 7, opcode: TerminalStreamOpcode.ReplayEnd },
  ]);
  expect(JSON.parse(new TextDecoder().decode(decoded[0]!.payload))).toEqual({
    rows: 30,
    cols: 120,
    retainedHistoryLines: 842,
  });
  expect(decoded[1]!.payload).toEqual(data);
  expect(decoded[2]!.payload.byteLength).toBe(0);
});
