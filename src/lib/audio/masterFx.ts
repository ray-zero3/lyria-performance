import { REVERB_SECONDS, REVERB_DECAY, STUTTER_DIVISION, DELAY_TIME_S } from "$lib/telemetry/constants";
import { computeFxParams, type FxBases } from "./fxParams";

/**
 * 手続き的リバーブ IR（アセット不要・決定的）。ノイズ×指数減衰。
 * 決定性のため xorshift32 の固定シードを使う（テスト安定＆再現性）。
 */
export function impulseResponseSamples(
  sampleRate: number,
  seconds: number,
  decay: number,
): Float32Array {
  const len = Math.max(1, Math.round(sampleRate * seconds));
  const out = new Float32Array(len);
  let seed = 0x2545f491 >>> 0;
  const rand = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return (seed / 0xffffffff) * 2 - 1; // -1..1
  };
  for (let i = 0; i < len; i++) {
    const env = Math.pow(1 - i / len, decay); // 1→0 の指数減衰
    out[i] = rand() * env;
  }
  return out;
}

export type MasterFxName = "reverb" | "stutter" | "filter" | "delay";

export interface MasterFx {
  /** デッキ gain の接続先（preMaster）。 */
  input: GainNode;
  /** destination / analyser の接続先（master）。 */
  output: AudioNode;
  /** カオスマクロ 0..1（全 FX を一括駆動。トランジションから駆動）。 */
  setChaos(v: number): void;
  /** 各 FX の個別 base 0..1。 */
  setBase(name: MasterFxName, v: number): void;
  /** ビートリピートのスライス長を bpm から算出。 */
  setBpm(bpm: number): void;
  dispose(): void;
}

/**
 * マスターFXチェーン:
 *   preMaster → beatRepeat(worklet) → filter(LPF)
 *     →┬ dry → master
 *      ├ delaySend → Delay ⇄ feedback → master
 *      └ reverbSend → Convolver → master
 * 定常時（chaos=0・全 base=0）は dry のみ＝従来音。値は setTargetAtTime で平滑化。
 * worklet 未対応/失敗時は stutter 無しでパススルー（フォールバック）。
 */
export async function createMasterFx(
  ctx: AudioContext,
  opts?: { seconds?: number; decay?: number; workletUrl?: string },
): Promise<MasterFx> {
  const seconds = opts?.seconds ?? REVERB_SECONDS;
  const decay = opts?.decay ?? REVERB_DECAY;

  const preMaster = ctx.createGain();
  const master = ctx.createGain();

  // reverb（send）
  const reverbSend = ctx.createGain();
  reverbSend.gain.value = 0;
  const conv = ctx.createConvolver();
  const irLen = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
  const samples = impulseResponseSamples(ctx.sampleRate, seconds, decay);
  ir.copyToChannel(samples, 0);
  ir.copyToChannel(samples, 1);
  conv.buffer = ir;

  // filter sweep（insert・LPF）
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 20000;
  filter.Q.value = 0.7;

  // delay（send＋feedback）
  const delaySend = ctx.createGain();
  delaySend.gain.value = 0;
  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = DELAY_TIME_S;
  const fb = ctx.createGain();
  fb.gain.value = 0;

  // beat-repeat（AudioWorklet insert・失敗時 null）
  let stutter: AudioWorkletNode | null = null;
  const workletUrl = opts?.workletUrl ?? "/worklets/beat-repeat.js";
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    stutter = new AudioWorkletNode(ctx, "beat-repeat");
  } catch (e) {
    stutter = null;
    console.warn("beat-repeat worklet 読込失敗（stutter 無しで継続）:", e);
  }

  // 配線
  if (stutter) {
    preMaster.connect(stutter);
    stutter.connect(filter);
  } else {
    preMaster.connect(filter);
  }
  filter.connect(master); // dry
  filter.connect(reverbSend);
  reverbSend.connect(conv);
  conv.connect(master); // reverb wet
  filter.connect(delaySend);
  delaySend.connect(delay);
  delay.connect(fb);
  fb.connect(delay); // feedback loop
  delay.connect(master); // delay wet

  const bases: FxBases = { reverb: 0, stutter: 0, filter: 0, delay: 0 };
  let chaos = 0;

  const apply = () => {
    const p = computeFxParams(bases, chaos);
    const now = ctx.currentTime;
    const tc = 0.02;
    reverbSend.gain.setTargetAtTime(p.reverbWet, now, tc);
    delaySend.gain.setTargetAtTime(p.delayWet, now, tc);
    fb.gain.setTargetAtTime(p.delayFeedback, now, tc);
    filter.frequency.setTargetAtTime(p.filterFreq, now, tc);
    filter.Q.setTargetAtTime(p.filterQ, now, tc);
    stutter?.parameters.get("mix")?.setTargetAtTime(p.stutterMix, now, tc);
  };
  apply();

  return {
    input: preMaster,
    output: master,
    setChaos(v: number) {
      chaos = v;
      apply();
    },
    setBase(name: MasterFxName, v: number) {
      bases[name] = v;
      apply();
    },
    setBpm(bpm: number) {
      const beatSec = 60 / Math.max(1, bpm);
      const frames = Math.max(1, Math.round(ctx.sampleRate * beatSec * STUTTER_DIVISION));
      const p = stutter?.parameters.get("sliceFrames");
      if (p) p.value = frames;
    },
    dispose() {
      for (const n of [preMaster, master, reverbSend, conv, filter, delaySend, delay, fb]) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
      try {
        stutter?.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}
