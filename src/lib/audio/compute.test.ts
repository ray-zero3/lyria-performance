import { describe, it, expect } from "vitest";
import {
  downsampleSpectrum,
  downsampleWaveform,
  computeBands,
  computeLevelPeak,
  computeOnset,
  computeFrame,
} from "./compute";
import { SPECTRUM_BINS, WAVEFORM_SAMPLES } from "$lib/telemetry/constants";

describe("downsampleSpectrum", () => {
  it("uniform 255 -> all 1.0, fixed length", () => {
    const f = new Uint8Array(1024).fill(255);
    const s = downsampleSpectrum(f, SPECTRUM_BINS);
    expect(s.length).toBe(SPECTRUM_BINS);
    expect(s.every((v) => Math.abs(v - 1) < 1e-9)).toBe(true);
  });
  it("empty -> zeros of fixed length", () => {
    expect(downsampleSpectrum(new Uint8Array(0), SPECTRUM_BINS).length).toBe(
      SPECTRUM_BINS,
    );
  });
});

describe("downsampleWaveform", () => {
  it("strided sampling, fixed length, first sample ~0 for sine", () => {
    const t = new Float32Array(2048);
    for (let i = 0; i < t.length; i++) t[i] = Math.sin((i / t.length) * Math.PI * 2);
    const w = downsampleWaveform(t, WAVEFORM_SAMPLES);
    expect(w.length).toBe(WAVEFORM_SAMPLES);
    expect(w[0]).toBeCloseTo(0, 5);
  });
});

describe("computeBands", () => {
  it("low-only energy -> low>0.9, mid/high=0", () => {
    const f = new Uint8Array(1024);
    for (let i = 0; i <= 10; i++) f[i] = 255; // 48000/2048=23.4Hz/bin -> i<=10 は <250Hz
    const b = computeBands(f, 48000, 2048);
    expect(b.low).toBeGreaterThan(0.9);
    expect(b.mid).toBe(0);
    expect(b.high).toBe(0);
  });
});

describe("computeLevelPeak", () => {
  it("sine amp 0.5 -> rms~0.354, peak~0.5", () => {
    const t = new Float32Array(1024);
    for (let i = 0; i < t.length; i++) {
      t[i] = 0.5 * Math.sin((i / t.length) * Math.PI * 2 * 4);
    }
    const { level, peak } = computeLevelPeak(t);
    expect(level).toBeCloseTo(0.354, 2);
    expect(peak).toBeCloseTo(0.5, 2);
  });
});

describe("computeOnset", () => {
  it("rising spectrum -> positive; falling -> 0", () => {
    const prev = new Array(SPECTRUM_BINS).fill(0.1);
    const up = new Array(SPECTRUM_BINS).fill(0.5);
    const down = new Array(SPECTRUM_BINS).fill(0.0);
    expect(computeOnset(up, prev)).toBeGreaterThan(0);
    expect(computeOnset(down, prev)).toBe(0);
  });
});

describe("computeFrame", () => {
  it("returns clamped fixed-length frame", () => {
    const freq = new Uint8Array(1024).fill(128);
    const time = new Float32Array(2048);
    for (let i = 0; i < time.length; i++) time[i] = Math.sin(i * 0.1);
    const f = computeFrame({
      freq,
      time,
      sampleRate: 48000,
      prevSpectrum: new Array(SPECTRUM_BINS).fill(0),
      seq: 7,
      tMs: 100,
    });
    expect(f.seq).toBe(7);
    expect(f.audio.spectrum.length).toBe(SPECTRUM_BINS);
    expect(f.audio.waveform.length).toBe(WAVEFORM_SAMPLES);
    expect(f.audio.level).toBeGreaterThan(0);
  });
});
