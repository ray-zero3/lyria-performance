import { describe, it, expect } from "vitest";
import { createBeatRepeatState, beatRepeatBlock } from "./beatRepeat";

// ヘルパ: 1ブロック処理して出力を配列で返す
function run(
  st: ReturnType<typeof createBeatRepeatState>,
  input: number[],
  mix: number,
  slice: number,
): number[] {
  const inArr = Float32Array.from(input);
  const outArr = new Float32Array(input.length);
  beatRepeatBlock(st, inArr, outArr, mix, slice);
  return Array.from(outArr);
}

describe("beatRepeatBlock", () => {
  it("mix=0 はパススルー（looping しない）", () => {
    const st = createBeatRepeatState(8);
    expect(run(st, [1, 2, 3, 4, 5, 6, 7, 8], 0, 4)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(st.looping).toBe(false);
  });

  it("mix=1 で直前 slice を凍結してループ", () => {
    const st = createBeatRepeatState(8);
    // まず ring を埋める（w が 8 個進み max8 で 0 に戻る）
    run(st, [1, 2, 3, 4, 5, 6, 7, 8], 0, 4);
    // 起動: 直前 slice(=4) = ring[4..7] = [5,6,7,8]
    expect(run(st, [0, 0, 0, 0], 1, 4)).toEqual([5, 6, 7, 8]);
    // ループ継続: frozen は input で上書きされない
    expect(run(st, [0, 0, 0, 0], 1, 4)).toEqual([5, 6, 7, 8]);
  });

  it("mix=0.5 は frozen と input のブレンド", () => {
    const st = createBeatRepeatState(8);
    run(st, [1, 2, 3, 4, 5, 6, 7, 8], 0, 4);
    // frozen=[5,6,7,8]、input=[10,10,10,10] → 0.5*frozen + 0.5*input
    const out = run(st, [10, 10, 10, 10], 0.5, 4);
    expect(out[0]).toBeCloseTo(0.5 * 5 + 0.5 * 10, 5);
    expect(out[3]).toBeCloseTo(0.5 * 8 + 0.5 * 10, 5);
  });

  it("mix=0 に戻すと再キャプチャする", () => {
    const st = createBeatRepeatState(8);
    run(st, [1, 2, 3, 4, 5, 6, 7, 8], 0, 4);
    run(st, [0, 0, 0, 0], 1, 4); // frozen=[5,6,7,8]
    run(st, [11, 12, 13, 14], 0, 4); // 解除＆ ring 更新（w=4..7 に上書き）
    expect(st.looping).toBe(false);
    // 再起動: 直前 slice = ring[4..7] = [11,12,13,14]
    expect(run(st, [0, 0, 0, 0], 1, 4)).toEqual([11, 12, 13, 14]);
  });
});
