import { describe, it, expect } from "vitest";
import { easeAlpha } from "./cameraRig";

describe("easeAlpha", () => {
  it("dt=0 は 0", () => {
    expect(easeAlpha(0, 300)).toBe(0);
  });
  it("dt=τ で ~0.632", () => {
    expect(easeAlpha(300, 300)).toBeCloseTo(1 - Math.exp(-1), 4);
  });
  it("dt≫τ で ~1", () => {
    expect(easeAlpha(5000, 300)).toBeGreaterThan(0.99);
  });
  it("τ<=0 は即時 1", () => {
    expect(easeAlpha(16, 0)).toBe(1);
  });
  it("0..1 に収まる", () => {
    expect(easeAlpha(-10, 300)).toBe(0);
    expect(easeAlpha(1e9, 300)).toBeLessThanOrEqual(1);
  });
});
