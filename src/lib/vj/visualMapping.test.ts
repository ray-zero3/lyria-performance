import { describe, it, expect } from "vitest";
import {
  onsetEnvelope,
  smoothSpectrum,
  bandsToColor,
  hslToRgb,
  secondaryColor,
  chaosToDissolve,
  motionSpeed,
  ONSET_DECAY_MS,
  SPEED_MAX,
  SPEED_MIN,
} from "./visualMapping";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";

describe("onsetEnvelope", () => {
  it("アタックは即時に onset 値へ跳ねる", () => {
    expect(onsetEnvelope(0, 0.8, 16)).toBeCloseTo(0.8);
  });
  it("減衰中でも大きい onset が来れば上書きされる", () => {
    expect(onsetEnvelope(0.3, 0.9, 16)).toBeCloseTo(0.9);
  });
  it("onset が無ければ指数減衰する（時定数で 1/e）", () => {
    expect(onsetEnvelope(0.8, 0, ONSET_DECAY_MS)).toBeCloseTo(0.8 / Math.E, 5);
  });
  it("連続フレームで単調減少する", () => {
    let v = 0.9;
    for (let i = 0; i < 10; i++) {
      const nv = onsetEnvelope(v, 0, 50);
      expect(nv).toBeLessThan(v);
      v = nv;
    }
  });
  it("dt=0 では減衰しない", () => {
    expect(onsetEnvelope(0.5, 0, 0)).toBeCloseTo(0.5);
  });
  it("不正値は clamp される（0..1）", () => {
    expect(onsetEnvelope(5, 2, 16)).toBe(1);
    expect(onsetEnvelope(NaN, NaN, NaN)).toBe(0);
  });
});

describe("smoothSpectrum", () => {
  const zeros = new Array<number>(SPECTRUM_BINS).fill(0);
  const ones = new Array<number>(SPECTRUM_BINS).fill(1);
  it("常に長さ SPECTRUM_BINS の新配列を返す（入力が空でも）", () => {
    expect(smoothSpectrum([], [], 16)).toHaveLength(SPECTRUM_BINS);
  });
  it("dt が大きいほど next へ収束する", () => {
    expect(smoothSpectrum(zeros, ones, 100000)[0]).toBeCloseTo(1, 3);
  });
  it("dt=0 なら prev を維持する", () => {
    const prev = zeros.map((_, i) => i / SPECTRUM_BINS);
    expect(smoothSpectrum(prev, ones, 0)[10]).toBeCloseTo(prev[10]);
  });
  it("prev を変異しない（イミュータブル）", () => {
    const prev = new Array<number>(SPECTRUM_BINS).fill(0.5);
    smoothSpectrum(prev, ones, 50);
    expect(prev.every((v) => v === 0.5)).toBe(true);
  });
  it("範囲外の入力は 0..1 に clamp される", () => {
    const out = smoothSpectrum(zeros, new Array<number>(SPECTRUM_BINS).fill(9), 100000);
    expect(Math.max(...out)).toBeLessThanOrEqual(1);
  });
});

describe("bandsToColor / hslToRgb / secondaryColor", () => {
  it("h/s/l は 0..1 に収まる", () => {
    const cases = [
      { low: 0, mid: 0, high: 0 },
      { low: 1, mid: 1, high: 1 },
      { low: 1, mid: 0, high: 0 },
      { low: 0, mid: 0, high: 1 },
    ];
    for (const b of cases) {
      const c = bandsToColor(b);
      for (const v of [c.h, c.s, c.l]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
  it("高域優勢は低域優勢より色相が進む", () => {
    expect(bandsToColor({ low: 0, mid: 0, high: 1 }).h).toBeGreaterThan(
      bandsToColor({ low: 1, mid: 0, high: 0 }).h,
    );
  });
  it("hslToRgb: 原色（赤）と無彩色", () => {
    const red = hslToRgb(0, 1, 0.5);
    expect(red.r).toBeCloseTo(1);
    expect(red.g).toBeCloseTo(0);
    expect(red.b).toBeCloseTo(0);
    const gray = hslToRgb(0.3, 0, 0.42);
    expect(gray.r).toBeCloseTo(0.42);
    expect(gray.g).toBeCloseTo(0.42);
  });
  it("secondaryColor はメイン色と十分離れる", () => {
    const hsl = bandsToColor({ low: 0.4, mid: 0.5, high: 0.2 });
    const a = hslToRgb(hsl.h, hsl.s, hsl.l);
    const b = secondaryColor(hsl);
    const d = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    expect(d).toBeGreaterThan(0.1);
  });
});

describe("chaosToDissolve", () => {
  it("0→0, 1→1", () => {
    expect(chaosToDissolve(0)).toBe(0);
    expect(chaosToDissolve(1)).toBe(1);
  });
  it("単調増加", () => {
    expect(chaosToDissolve(0.3)).toBeLessThan(chaosToDissolve(0.6));
  });
  it("範囲外は clamp", () => {
    expect(chaosToDissolve(-1)).toBe(0);
    expect(chaosToDissolve(2)).toBe(1);
  });
});

describe("motionSpeed", () => {
  it("基準 bpm(120) で 1.0", () => {
    expect(motionSpeed(120)).toBe(1);
  });
  it("bpm に比例（60→0.5）", () => {
    expect(motionSpeed(60)).toBe(0.5);
  });
  it("上下限にクランプ", () => {
    expect(motionSpeed(10000)).toBe(SPEED_MAX);
    expect(motionSpeed(1)).toBe(SPEED_MIN);
  });
  it("不正値（NaN/0/負）は 1", () => {
    expect(motionSpeed(NaN)).toBe(1);
    expect(motionSpeed(0)).toBe(1);
    expect(motionSpeed(-5)).toBe(1);
  });
});
