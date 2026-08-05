// 緊急回避（コンシール）の判定ロジック＋ノード生成。
// 判定は純粋関数（Vitest で検証可能）。DSP は static/worklets/conceal.js が担当。
//
// 検知: preGain（Lyria 合流バス＝リバーブ前の生レベル）のピークを driver が毎フレーム観測し、
// concealDecision で phase を進め、conceal パラメータ(0..1)を fade で自動化する。

export type ConcealPhase = "normal" | "conceal";

export interface ConcealState {
  phase: ConcealPhase;
  /** 現在 phase の経過 ms。 */
  phaseMs: number;
  /** 連続無音の累積 ms（normal 時）。 */
  silentMs: number;
  /** 一度でも十分な信号を観測したか（起動直後の無音で誤発動しないためのアーム）。 */
  armed: boolean;
}

export interface ConcealCfg {
  /** これ未満のピーク＝「信号なし」（瞬断＝ほぼ完全な 0 を想定し低め）。 */
  silenceThresh: number;
  /** これ超のピーク＝「信号あり／復帰」。silenceThresh より十分大きくヒステリシス。 */
  reviveThresh: number;
  /** 無音がこの ms 続いたら conceal 開始（予兆寄りに短め）。 */
  dropoutHoldMs: number;
  /** 一度 conceal したら最低この ms は保持（パタつき防止）。 */
  minConcealMs: number;
}

export const DEFAULT_CONCEAL_CFG: ConcealCfg = {
  silenceThresh: 0.0016,
  reviveThresh: 0.012,
  dropoutHoldMs: 80,
  minConcealMs: 250,
};

/** conceal パラメータの fade（秒）。開始は速く、復帰はやや長く。 */
export const CONCEAL_FADE_IN_S = 0.09;
export const CONCEAL_FADE_OUT_S = 0.4;

export function initConcealState(): ConcealState {
  return { phase: "normal", phaseMs: 0, silentMs: 0, armed: false };
}

/**
 * 生レベルのピークから次状態と conceal 目標(0|1)を求める純粋関数。
 * dtMs は 0..200 にクランプ（タブ復帰等の巨大 dt 対策）。
 */
export function concealDecision(
  s: ConcealState,
  peak: number,
  dtMs: number,
  cfg: ConcealCfg = DEFAULT_CONCEAL_CFG,
): { state: ConcealState; target: 0 | 1 } {
  const dt = Math.max(0, Math.min(200, Number.isFinite(dtMs) ? dtMs : 0));
  let phase = s.phase;
  let phaseMs = s.phaseMs + dt;
  let silentMs = s.silentMs;
  let armed = s.armed || peak > cfg.reviveThresh;

  if (phase === "normal") {
    silentMs = peak < cfg.silenceThresh ? silentMs + dt : 0;
    if (armed && silentMs >= cfg.dropoutHoldMs) {
      phase = "conceal";
      phaseMs = 0;
    }
  } else {
    if (phaseMs >= cfg.minConcealMs && peak > cfg.reviveThresh) {
      phase = "normal";
      phaseMs = 0;
      silentMs = 0;
    }
  }

  return { state: { phase, phaseMs, silentMs, armed }, target: phase === "conceal" ? 1 : 0 };
}

/** conceal ワークレットノードを生成（モジュール登録込み）。ステレオ出力。 */
export async function createConcealNode(
  ctx: AudioContext,
  workletUrl: string,
): Promise<AudioWorkletNode> {
  await ctx.audioWorklet.addModule(workletUrl);
  return new AudioWorkletNode(ctx, "conceal", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
}

/** 時間領域バッファの絶対値ピーク。 */
export function peakOf(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i];
    if (a > p) p = a;
  }
  return p;
}
