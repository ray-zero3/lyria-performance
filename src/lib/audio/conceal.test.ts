import { describe, it, expect } from "vitest";
import {
  concealDecision,
  initConcealState,
  peakOf,
  DEFAULT_CONCEAL_CFG,
  type ConcealState,
} from "./conceal";

const cfg = DEFAULT_CONCEAL_CFG;
const LOUD = 0.2; // 十分な信号
const SILENT = 0; // 完全無音（瞬断）

/** peak を dt ずつ n 回与えて状態を進める。 */
function run(s: ConcealState, peak: number, dt: number, n: number): ConcealState {
  let st = s;
  for (let i = 0; i < n; i++) st = concealDecision(st, peak, dt, cfg).state;
  return st;
}

describe("concealDecision（緊急回避の状態遷移）", () => {
  it("起動直後（未アーム）の無音では conceal しない", () => {
    const st = run(initConcealState(), SILENT, 16, 40); // 640ms 無音でも
    expect(st.armed).toBe(false);
    expect(st.phase).toBe("normal");
  });

  it("信号を観測→アーム後に無音 dropoutHoldMs 継続で conceal 開始", () => {
    let st = run(initConcealState(), LOUD, 16, 5); // アーム
    expect(st.armed).toBe(true);
    // まだ hold 未満（一発目）
    const r1 = concealDecision(st, SILENT, 16, cfg);
    expect(r1.state.phase).toBe("normal");
    // hold(80ms) を超えるまで無音継続
    st = run(st, SILENT, 16, 6); // 96ms
    expect(st.phase).toBe("conceal");
    expect(concealDecision(st, SILENT, 16, cfg).target).toBe(1);
  });

  it("無音が途切れる（信号復活）と silentMs はリセットされ conceal しない", () => {
    let st = run(initConcealState(), LOUD, 16, 5);
    st = run(st, SILENT, 16, 3); // 48ms 無音（hold 未満）
    st = concealDecision(st, LOUD, 16, cfg).state; // 信号復活
    expect(st.silentMs).toBe(0);
    st = run(st, SILENT, 16, 4); // 再び 64ms（hold 未満）
    expect(st.phase).toBe("normal");
  });

  it("conceal 中は minConcealMs 未満なら信号が戻っても保持", () => {
    let st = run(initConcealState(), LOUD, 16, 5);
    st = run(st, SILENT, 16, 6); // conceal 突入
    expect(st.phase).toBe("conceal");
    // すぐ信号が戻っても minConceal(250ms) 未満は保持
    st = run(st, LOUD, 16, 5); // 80ms
    expect(st.phase).toBe("conceal");
  });

  it("conceal 中に minConcealMs 経過＋信号復活で normal へ復帰", () => {
    let st = run(initConcealState(), LOUD, 16, 5);
    st = run(st, SILENT, 16, 6); // conceal
    st = run(st, LOUD, 16, 20); // 320ms 信号継続
    expect(st.phase).toBe("normal");
    expect(concealDecision(st, LOUD, 16, cfg).target).toBe(0);
  });

  it("巨大 dt はクランプされる（暴発防止）", () => {
    let st = run(initConcealState(), LOUD, 16, 5);
    const r = concealDecision(st, SILENT, 100000, cfg);
    // 1 回の巨大 dt でも silentMs は 200ms 上限までしか進まない → 即 conceal はするが破綻しない
    expect(r.state.silentMs).toBeLessThanOrEqual(200);
  });
});

describe("peakOf", () => {
  it("絶対値の最大を返す", () => {
    expect(peakOf(new Float32Array([0, -0.5, 0.3, -0.9, 0.1]))).toBeCloseTo(0.9, 5);
    expect(peakOf(new Float32Array([0, 0, 0]))).toBe(0);
  });
});
