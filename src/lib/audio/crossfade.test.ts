import { describe, it, expect } from "vitest";
import { equalPowerGains, transitionEnvelope, type TransitionPlan } from "./crossfade";

const PLAN: TransitionPlan = { leadMs: 2000, fadeMs: 4000, tailMs: 2000, wetPeak: 0.5 };

describe("equalPowerGains", () => {
  it("t=0 は out=1, incoming=0", () => {
    const g = equalPowerGains(0);
    expect(g.out).toBeCloseTo(1, 5);
    expect(g.incoming).toBeCloseTo(0, 5);
  });
  it("t=1 は out=0, incoming=1", () => {
    const g = equalPowerGains(1);
    expect(g.out).toBeCloseTo(0, 5);
    expect(g.incoming).toBeCloseTo(1, 5);
  });
  it("t=0.5 は両方 ~0.707 で定パワー", () => {
    const g = equalPowerGains(0.5);
    expect(g.out).toBeCloseTo(Math.SQRT1_2, 4);
    expect(g.incoming).toBeCloseTo(Math.SQRT1_2, 4);
    expect(g.out ** 2 + g.incoming ** 2).toBeCloseTo(1, 4);
  });
  it("範囲外は clamp", () => {
    expect(equalPowerGains(-1).out).toBeCloseTo(1, 5);
    expect(equalPowerGains(2).incoming).toBeCloseTo(1, 5);
  });
});

describe("transitionEnvelope", () => {
  it("LEAD: wet が 0→peak、gain は 1/0、drums 両方 mute", () => {
    const s0 = transitionEnvelope(0, PLAN);
    expect(s0.phase).toBe("lead");
    expect(s0.outGain).toBe(1);
    expect(s0.inGain).toBe(0);
    expect(s0.wet).toBeCloseTo(0, 5);
    expect(s0.muteDrumsOut).toBe(true);
    expect(s0.muteDrumsIn).toBe(true);
    const sMid = transitionEnvelope(1000, PLAN);
    expect(sMid.wet).toBeCloseTo(0.25, 3); // 1000/2000 * 0.5
  });
  it("FADE: equal-power で out→in、wet=peak", () => {
    const sStart = transitionEnvelope(2000, PLAN);
    expect(sStart.phase).toBe("fade");
    expect(sStart.outGain).toBeCloseTo(1, 4);
    expect(sStart.inGain).toBeCloseTo(0, 4);
    expect(sStart.wet).toBeCloseTo(0.5, 5);
    const sMid = transitionEnvelope(4000, PLAN); // fade 半分
    expect(sMid.outGain).toBeCloseTo(Math.SQRT1_2, 3);
    expect(sMid.inGain).toBeCloseTo(Math.SQRT1_2, 3);
    expect(sMid.progress).toBeCloseTo(0.5, 3);
  });
  it("TAIL: gain 0/1、wet peak→0、新セッションのドラム復帰", () => {
    const s = transitionEnvelope(7000, PLAN); // tail 半分 (6000..8000)
    expect(s.phase).toBe("tail");
    expect(s.outGain).toBe(0);
    expect(s.inGain).toBe(1);
    expect(s.wet).toBeCloseTo(0.25, 3); // 0.5 * (1 - 0.5)
    expect(s.muteDrumsIn).toBe(false);
  });
  it("done: 総時間超過で out=0,in=1,wet=0", () => {
    const s = transitionEnvelope(99999, PLAN);
    expect(s.phase).toBe("done");
    expect(s.outGain).toBe(0);
    expect(s.inGain).toBe(1);
    expect(s.wet).toBe(0);
    expect(s.muteDrumsIn).toBe(false);
  });
  it("負値は LEAD 開始扱い", () => {
    expect(transitionEnvelope(-500, PLAN).phase).toBe("lead");
  });
});
