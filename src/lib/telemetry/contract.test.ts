import { describe, it, expect } from "vitest";
import { defaultHubState, clampFrame, clamp01, clampRange } from "./contract";
import { SPECTRUM_BINS, WAVEFORM_SAMPLES, DURATION_CAP_MS } from "./constants";

describe("clamp helpers", () => {
  it("clamp01 clamps to [0,1]", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
  it("clamp01 maps NaN to 0", () => {
    expect(clamp01(NaN)).toBe(0);
  });
  it("clampRange clamps to [lo,hi]", () => {
    expect(clampRange(5, 0, 3)).toBe(3);
    expect(clampRange(-5, 0, 3)).toBe(0);
  });
});

describe("defaultHubState", () => {
  it("has idle session and cap", () => {
    const s = defaultHubState();
    expect(s.session.state).toBe("idle");
    expect(s.session.durationCapMs).toBe(DURATION_CAP_MS);
    expect(s.session.startedAtMs).toBeNull();
    expect(Array.isArray(s.prompts)).toBe(true);
  });
});

describe("clampFrame", () => {
  it("normalizes array lengths to fixed sizes", () => {
    const f = clampFrame({
      tMs: 123,
      seq: 1,
      audio: {
        level: 2,
        peak: -1,
        bands: { low: 5, mid: 0.2, high: 0.3 },
        spectrum: [1, 2],
        waveform: [3],
        onset: 9,
      },
    });
    expect(f.audio.spectrum.length).toBe(SPECTRUM_BINS);
    expect(f.audio.waveform.length).toBe(WAVEFORM_SAMPLES);
    expect(f.audio.level).toBe(1); // clamped
    expect(f.audio.peak).toBe(0); // clamped
    expect(f.audio.bands.low).toBe(1);
    expect(f.audio.onset).toBe(1);
  });
  it("survives garbage input without throwing", () => {
    const f = clampFrame(null);
    expect(f.audio.spectrum.length).toBe(SPECTRUM_BINS);
    expect(f.audio.waveform.length).toBe(WAVEFORM_SAMPLES);
    expect(f.seq).toBe(0);
  });
  it("clamps waveform to [-1,1] and spectrum to [0,1]", () => {
    const f = clampFrame({
      tMs: 0,
      seq: 0,
      audio: {
        level: 0,
        peak: 0,
        bands: { low: 0, mid: 0, high: 0 },
        spectrum: new Array(SPECTRUM_BINS).fill(9),
        waveform: new Array(WAVEFORM_SAMPLES).fill(-9),
        onset: 0,
      },
    });
    expect(f.audio.spectrum.every((v) => v === 1)).toBe(true);
    expect(f.audio.waveform.every((v) => v === -1)).toBe(true);
  });
});
