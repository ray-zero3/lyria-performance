// M7 調整: VJ アニメーションのイージング係数（純粋）。
// ピン移動/出現/消失・カーソル・カメラ激しさ・床反応の平滑に使う。
/** 指数平滑の補間係数 α = 1 - e^(-dt/τ)（0..1）。dt, τ は ms。τ<=0 は即時 1。 */
export function easeAlpha(dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return 1;
  const a = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return a < 0 ? 0 : a > 1 ? 1 : a;
}
