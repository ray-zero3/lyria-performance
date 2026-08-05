import { describe, it, expect } from "vitest";
import { makeDummyFrame, maybeDummyEvent, dummyStateAt } from "./dummy";
import { SPECTRUM_BINS, WAVEFORM_SAMPLES } from "./constants";

describe("makeDummyFrame", () => {
  it("is deterministic for the same inputs", () => {
    const a = makeDummyFrame(10, 1000);
    const b = makeDummyFrame(10, 1000);
    expect(a).toEqual(b);
  });
  it("produces in-range fixed-length arrays", () => {
    const f = makeDummyFrame(3, 500);
    expect(f.audio.spectrum.length).toBe(SPECTRUM_BINS);
    expect(f.audio.waveform.length).toBe(WAVEFORM_SAMPLES);
    expect(f.audio.level).toBeGreaterThanOrEqual(0);
    expect(f.audio.level).toBeLessThanOrEqual(1);
    expect(Math.min(...f.audio.waveform)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...f.audio.waveform)).toBeLessThanOrEqual(1);
    expect(f.seq).toBe(3);
  });
});

describe("maybeDummyEvent", () => {
  it("returns an event on the emit cadence and null otherwise", () => {
    // 30フレームに1回 control を出す設計
    expect(maybeDummyEvent(30, 480)).not.toBeNull();
    expect(maybeDummyEvent(1, 16)).toBeNull();
  });
});

describe("dummyStateAt", () => {
  it("reports playing with a started session", () => {
    const s = dummyStateAt(0, 1000);
    expect(s.session.state).toBe("playing");
    expect(s.session.startedAtMs).toBe(0);
    expect(s.prompts.length).toBeGreaterThan(0);
  });
});
