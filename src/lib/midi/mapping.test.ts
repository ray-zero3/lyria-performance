import { describe, it, expect } from "vitest";
import { midiKey, scaleCc, isContinuous, applyMidi } from "./mapping";
import { bind } from "./store";
import type { MidiMapping, MidiMessage } from "./types";

const cc = (id: number, value: number, channel = 0): MidiMessage => ({
  kind: "cc",
  channel,
  id,
  value,
  on: true,
});
const note = (id: number, value: number, on: boolean, channel = 0): MidiMessage => ({
  kind: "note",
  channel,
  id,
  value,
  on,
});

describe("midiKey", () => {
  it("formats kind:channel:id", () => {
    expect(midiKey(cc(74, 0))).toBe("cc:0:74");
    expect(midiKey(note(36, 0, true))).toBe("note:0:36");
  });
});

describe("scaleCc", () => {
  it("maps 0..127 into target range", () => {
    expect(scaleCc(0, "bpm")).toBe(60);
    expect(scaleCc(127, "bpm")).toBe(200);
    expect(scaleCc(127, "density")).toBe(1);
    expect(scaleCc(0, "guidance")).toBe(0);
    expect(scaleCc(127, "guidance")).toBeCloseTo(6, 5);
  });
  it("clamps out-of-range", () => {
    expect(scaleCc(999, "brightness")).toBe(1);
    expect(scaleCc(-5, "brightness")).toBe(0);
  });
});

describe("isContinuous", () => {
  it("classifies targets", () => {
    expect(isContinuous("bpm")).toBe(true);
    expect(isContinuous("reset_context")).toBe(false);
  });
  it("M7: cursorX/cursorY は連続、morph_next はアクション", () => {
    expect(isContinuous("cursorX")).toBe(true);
    expect(isContinuous("cursorY")).toBe(true);
    expect(isContinuous("morph_next")).toBe(false);
  });
});

describe("scaleCc (M7 cursor)", () => {
  it("cursorX/cursorY は 0..1 に写像", () => {
    expect(scaleCc(0, "cursorX")).toBe(0);
    expect(scaleCc(127, "cursorX")).toBe(1);
    expect(scaleCc(63, "cursorY")).toBeCloseTo(63 / 127, 6);
  });
});

describe("applyMidi", () => {
  const mapping: MidiMapping = {
    "cc:0:74": "brightness",
    "note:0:36": "reset_context",
  };
  it("returns null for unmapped", () => {
    expect(applyMidi(cc(1, 100), mapping)).toBeNull();
  });
  it("scales continuous CC", () => {
    const r = applyMidi(cc(74, 127), mapping);
    expect(r?.continuous?.target).toBe("brightness");
    expect(r?.continuous?.value).toBe(1);
  });
  it("fires action on note-on, not note-off", () => {
    expect(applyMidi(note(36, 100, true), mapping)?.action).toBe("reset_context");
    expect(applyMidi(note(36, 0, false), mapping)?.action).toBeUndefined();
  });
});

describe("bind", () => {
  it("binds a message to a target and dedupes the target", () => {
    let m: MidiMapping = {};
    m = bind(m, cc(20, 0), "bpm");
    m = bind(m, cc(21, 0), "bpm"); // 同一 target を別 CC へ → 旧束縛解除
    expect(m["cc:0:20"]).toBeUndefined();
    expect(m["cc:0:21"]).toBe("bpm");
  });
});
