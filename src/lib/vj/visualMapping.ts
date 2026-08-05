import { clamp01 } from "$lib/telemetry/contract";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";

/** onset エンベロープの減衰時定数（ms）。大きいほど余韻が長い（live 調整ポイント）。 */
export const ONSET_DECAY_MS = 180;
/** spectrum 平滑の時定数（ms）。大きいほどゆったり追従（live 調整ポイント）。 */
export const SPECTRUM_SMOOTH_MS = 120;
/** motionSpeed のクランプ範囲と基準 bpm。 */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 2.5;
export const SPEED_BASE_BPM = 120;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Hsl {
  h: number;
  s: number;
  l: number;
}
export interface Bands {
  low: number;
  mid: number;
  high: number;
}

/** VJ シーンへ渡す 1 フレーム分の視覚パラメータ（純データ）。 */
export interface VisualParams {
  burst: number; // onset エンベロープ 0..1
  spectrum: readonly number[]; // 平滑済み 48bin 0..1
  level: number; // 0..1
  bands: Bands;
  colorA: Rgb; // メイン色（bands 由来）
  colorB: Rgb; // サブ色（補色系）
  speed: number; // bpm テンポ係数
}

/** onset を attack/decay のバースト値へ。アタック即時・指数減衰。純粋。 */
export function onsetEnvelope(prev: number, onset: number, dtMs: number): number {
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  const decayed = clamp01(prev) * Math.exp(-dt / ONSET_DECAY_MS);
  return clamp01(Math.max(decayed, clamp01(onset)));
}

/** spectrum[48] の時間平滑（片極 IIR）。常に長さ SPECTRUM_BINS の新配列。純粋。 */
export function smoothSpectrum(
  prev: readonly number[],
  next: readonly number[],
  dtMs: number,
): number[] {
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  const alpha = 1 - Math.exp(-dt / SPECTRUM_SMOOTH_MS);
  const out = new Array<number>(SPECTRUM_BINS);
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const p = clamp01(typeof prev[i] === "number" ? prev[i] : 0);
    const n = clamp01(typeof next[i] === "number" ? next[i] : 0);
    out[i] = p + (n - p) * alpha;
  }
  return out;
}

/** low/mid/high → HSL。低域=青紫寄り・高域=ピンク寄りへ色相シフト。純粋。 */
export function bandsToColor(bands: Bands): Hsl {
  const low = clamp01(bands?.low ?? 0);
  const mid = clamp01(bands?.mid ?? 0);
  const high = clamp01(bands?.high ?? 0);
  const h = (((0.62 + 0.22 * high - 0.1 * low + 0.05 * mid) % 1) + 1) % 1;
  const s = clamp01(0.55 + 0.35 * mid);
  const l = clamp01(0.4 + 0.2 * ((low + mid + high) / 3));
  return { h, s, l };
}

/** HSL(0..1) → RGB(0..1)。標準変換。純粋。 */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = ((h % 1) + 1) % 1;
  const ss = clamp01(s);
  const ll = clamp01(l);
  if (ss === 0) return { r: ll, g: ll, b: ll };
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const f = (t: number): number => {
    const tt = ((t % 1) + 1) % 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return { r: f(hh + 1 / 3), g: f(hh), b: f(hh - 1 / 3) };
}

/** サブ色: メイン HSL から色相を +0.42 回した補色系。純粋。 */
export function secondaryColor(hsl: Hsl): Rgb {
  return hslToRgb(hsl.h + 0.42, clamp01(hsl.s * 0.9), clamp01(hsl.l * 1.15));
}

/** chaos(0..1) → 溶解量。単調・0→0・1→1。純粋。 */
export function chaosToDissolve(chaos: number): number {
  return Math.pow(clamp01(chaos), 1.4);
}

/** bpm → テンポ係数。120bpm=1.0、[SPEED_MIN, SPEED_MAX] にクランプ。不正値は 1。純粋。 */
export function motionSpeed(bpm: number): number {
  if (typeof bpm !== "number" || !Number.isFinite(bpm) || bpm <= 0) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, bpm / SPEED_BASE_BPM));
}
