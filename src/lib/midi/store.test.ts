import { describe, it, expect } from "vitest";
import { bind, unbind } from "./store";
import type { MidiMapping } from "./types";

describe("midi store bind/unbind（純粋・immutable）", () => {
  const msg = { kind: "cc" as const, channel: 0, id: 74 };

  it("bind: 指定 msg を target に束縛（同一 target の既存束縛は解除）", () => {
    const m0: MidiMapping = { "cc:0:20": "bpm" };
    const m1 = bind(m0, msg, "bpm"); // bpm を別 CC に付け替え
    expect(m1).toEqual({ "cc:0:74": "bpm" }); // 旧 cc:0:20 は解除
    expect(m0).toEqual({ "cc:0:20": "bpm" }); // 元は不変
  });

  it("bind: 別 target は共存", () => {
    const m = bind({ "cc:0:20": "guidance" }, msg, "bpm");
    expect(m).toEqual({ "cc:0:20": "guidance", "cc:0:74": "bpm" });
  });

  it("unbind: 指定 target の束縛のみ解除", () => {
    const m0: MidiMapping = { "cc:0:74": "bpm", "cc:0:20": "guidance" };
    const m1 = unbind(m0, "bpm");
    expect(m1).toEqual({ "cc:0:20": "guidance" });
    expect(m0).toEqual({ "cc:0:74": "bpm", "cc:0:20": "guidance" }); // 元は不変
  });

  it("unbind: 未束縛 target は実質そのまま", () => {
    const m0: MidiMapping = { "cc:0:20": "guidance" };
    expect(unbind(m0, "bpm")).toEqual(m0);
  });
});
