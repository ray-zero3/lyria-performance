import {
  CONTINUOUS_TARGETS,
  type ActionTarget,
  type ContinuousTarget,
  type MidiMapping,
  type MidiMessage,
  type MidiTarget,
} from "./types";

export function midiKey(m: Pick<MidiMessage, "kind" | "channel" | "id">): string {
  return `${m.kind}:${m.channel}:${m.id}`;
}

const RANGES: Record<ContinuousTarget, [number, number]> = {
  bpm: [60, 200],
  guidance: [0, 6],
  density: [0, 1],
  brightness: [0, 1],
  temperature: [0, 2],
  // M5b: マスターFX（全て 0..1）
  chaos: [0, 1],
  fxReverb: [0, 1],
  fxStutter: [0, 1],
  fxFilter: [0, 1],
  fxDelay: [0, 1],
  // M7: プロンプト空間カーソル（0..1）
  cursorX: [0, 1],
  cursorY: [0, 1],
  // VJ パラメータ（すべて 0..1）
  cameraEnergy: [0, 1],
  constellation: [0, 1],
  vjGlitch: [0, 1],
  vjSplit: [0, 1],
  vjRgbShift: [0, 1],
  vjBloom: [0, 1],
  vjScanline: [0, 1],
  vjTimemachine: [0, 1],
  vjBlob: [0, 1],
};

/** CC値(0-127) を連続ターゲットの範囲へスケール。 */
export function scaleCc(value: number, target: ContinuousTarget): number {
  const [lo, hi] = RANGES[target];
  const v = Math.max(0, Math.min(127, value)) / 127;
  return lo + v * (hi - lo);
}

const CONTINUOUS = new Set<MidiTarget>(CONTINUOUS_TARGETS);
export function isContinuous(t: MidiTarget): t is ContinuousTarget {
  return CONTINUOUS.has(t);
}

export interface MidiApplyResult {
  target: MidiTarget;
  continuous?: { target: ContinuousTarget; value: number };
  action?: ActionTarget; // note-on / CC>63 のときのみ
}

/** MIDI メッセージをマップに照合して適用結果を返す（未マップは null）。純粋。 */
export function applyMidi(m: MidiMessage, mapping: MidiMapping): MidiApplyResult | null {
  const t = mapping[midiKey(m)];
  if (!t) return null;
  if (isContinuous(t)) {
    return { target: t, continuous: { target: t, value: scaleCc(m.value, t) } };
  }
  const triggered = m.kind === "note" ? m.on && m.value > 0 : m.value > 63;
  return triggered ? { target: t, action: t } : { target: t };
}
