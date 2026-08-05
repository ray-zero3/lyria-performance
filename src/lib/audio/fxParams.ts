import { clamp01 } from "$lib/telemetry/contract";

/** 各 FX の個別 base（0..1）。UI/MIDI で調整。 */
export interface FxBases {
  reverb: number;
  stutter: number;
  filter: number;
  delay: number;
}

/** マスターFXノードへ反映する具体値。 */
export interface FxParams {
  reverbWet: number; // reverbSend gain 0..1
  stutterMix: number; // beat-repeat worklet mix 0..1
  filterFreq: number; // Hz（全開 20k → closed 300）
  filterQ: number;
  delayWet: number; // delaySend gain 0..1
  delayFeedback: number; // feedback gain 0..~0.82
}

export const FILTER_OPEN_HZ = 20000;
export const FILTER_CLOSED_HZ = 300;

// カオスマクロが各 FX にどれだけ上乗せするか（weight）。
// フルカオス(1.0)で全 FX を強く効かせる（filter は完全 closed まで掃引）。
const CHAOS_WEIGHT: FxBases = {
  reverb: 0.7,
  stutter: 1.0,
  filter: 1.0,
  delay: 0.8,
};

/**
 * 各 FX 実効量 = clamp01(base + chaos*weight)。個別 base は floor、カオスマクロが一括上乗せ。
 * filterFreq は対数スイープ（全開→closed）。純粋関数。
 */
export function computeFxParams(bases: FxBases, chaos: number): FxParams {
  const amt = (base: number, w: number) => clamp01(base + chaos * w);
  const reverbAmt = amt(bases.reverb, CHAOS_WEIGHT.reverb);
  const stutterAmt = amt(bases.stutter, CHAOS_WEIGHT.stutter);
  const filterAmt = amt(bases.filter, CHAOS_WEIGHT.filter);
  const delayAmt = amt(bases.delay, CHAOS_WEIGHT.delay);
  return {
    reverbWet: reverbAmt,
    stutterMix: stutterAmt,
    filterFreq: FILTER_OPEN_HZ * Math.pow(FILTER_CLOSED_HZ / FILTER_OPEN_HZ, filterAmt),
    filterQ: 0.7 + filterAmt * 8,
    delayWet: delayAmt,
    delayFeedback: delayAmt * 0.82,
  };
}
