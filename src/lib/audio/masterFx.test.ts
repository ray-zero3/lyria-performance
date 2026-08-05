import { describe, it, expect } from "vitest";
import { impulseResponseSamples } from "./masterFx";

describe("impulseResponseSamples", () => {
  it("長さは round(sampleRate*seconds)", () => {
    const s = impulseResponseSamples(48000, 2, 2);
    expect(s.length).toBe(96000);
  });
  it("全値が [-1,1] に収まる", () => {
    const s = impulseResponseSamples(48000, 1, 2);
    for (let i = 0; i < s.length; i += 137) {
      expect(s[i]).toBeGreaterThanOrEqual(-1);
      expect(s[i]).toBeLessThanOrEqual(1);
    }
  });
  it("末尾は指数減衰で ~0", () => {
    const s = impulseResponseSamples(48000, 1, 2);
    expect(Math.abs(s[s.length - 1])).toBeLessThan(0.01);
  });
  it("decay が大きいほど後半のエネルギーが小さい", () => {
    const rms = (a: Float32Array, from: number) => {
      let sum = 0;
      let n = 0;
      for (let i = from; i < a.length; i++) {
        sum += a[i] * a[i];
        n++;
      }
      return Math.sqrt(sum / n);
    };
    const soft = impulseResponseSamples(48000, 1, 1);
    const hard = impulseResponseSamples(48000, 1, 4);
    const half = Math.floor(soft.length / 2);
    expect(rms(hard, half)).toBeLessThan(rms(soft, half));
  });
  it("決定的（同じ入力で同じ出力）", () => {
    const a = impulseResponseSamples(8000, 0.5, 2);
    const b = impulseResponseSamples(8000, 0.5, 2);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
