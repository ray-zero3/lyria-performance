import { describe, it, expect } from "vitest";
import { objectTargets, effectTargets } from "./vjToggles";

describe("objectTargets / effectTargets（carry → VJ 目標値の純粋マッピング）", () => {
  it("objectTargets: true→1、false/未指定→0", () => {
    expect(objectTargets({ horizon: true })).toEqual({ horizon: 1 });
    expect(objectTargets(undefined)).toEqual({ horizon: 0 });
  });

  it("effectTargets: clamp01・未指定/不正→0", () => {
    expect(effectTargets({ glitch: 0.4, split: 7, bloom: -2 })).toEqual({
      glitch: 0.4,
      split: 1,
      rgbShift: 0,
      bloom: 0,
      scanline: 0,
      timemachine: 0,
      blob: 0,
    });
    expect(effectTargets(undefined)).toEqual({
      glitch: 0,
      split: 0,
      rgbShift: 0,
      bloom: 0,
      scanline: 0,
      timemachine: 0,
      blob: 0,
    });
    expect(effectTargets({ rgbShift: Number.NaN })).toEqual({
      glitch: 0,
      split: 0,
      rgbShift: 0,
      bloom: 0,
      scanline: 0,
      timemachine: 0,
      blob: 0,
    });
  });
});
