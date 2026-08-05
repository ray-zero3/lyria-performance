import { describe, it, expect } from "vitest";
import {
  computeFxParams,
  FILTER_OPEN_HZ,
  FILTER_CLOSED_HZ,
  type FxBases,
} from "./fxParams";

const ZERO: FxBases = { reverb: 0, stutter: 0, filter: 0, delay: 0 };

describe("computeFxParams", () => {
  it("chaos=0・base=0 は透過値", () => {
    const p = computeFxParams(ZERO, 0);
    expect(p.reverbWet).toBe(0);
    expect(p.stutterMix).toBe(0);
    expect(p.delayWet).toBe(0);
    expect(p.delayFeedback).toBe(0);
    expect(p.filterFreq).toBeCloseTo(FILTER_OPEN_HZ, 0);
    expect(p.filterQ).toBeCloseTo(0.7, 5);
  });

  it("chaos=1 で全 FX が上昇し filterFreq が closed へ", () => {
    const p = computeFxParams(ZERO, 1);
    expect(p.reverbWet).toBeGreaterThan(0.4);
    expect(p.stutterMix).toBeGreaterThan(0.8);
    expect(p.delayWet).toBeGreaterThan(0.5);
    expect(p.delayFeedback).toBeGreaterThan(0.4);
    expect(p.filterFreq).toBeCloseTo(FILTER_CLOSED_HZ, 0);
    expect(p.filterQ).toBeGreaterThan(5);
  });

  it("base が floor になる（chaos=0 でも base 分は効く）", () => {
    const p = computeFxParams({ ...ZERO, reverb: 0.5, delay: 0.3 }, 0);
    expect(p.reverbWet).toBeCloseTo(0.5, 5);
    expect(p.delayWet).toBeCloseTo(0.3, 5);
  });

  it("chaos に対して単調増加、filterFreq は単調減少", () => {
    const a = computeFxParams(ZERO, 0.2);
    const b = computeFxParams(ZERO, 0.6);
    expect(b.reverbWet).toBeGreaterThan(a.reverbWet);
    expect(b.stutterMix).toBeGreaterThan(a.stutterMix);
    expect(b.delayWet).toBeGreaterThan(a.delayWet);
    expect(b.filterFreq).toBeLessThan(a.filterFreq);
  });

  it("base+chaos は clamp01 で 1 を超えない", () => {
    const p = computeFxParams({ ...ZERO, stutter: 0.9 }, 1);
    expect(p.stutterMix).toBe(1);
  });
});
