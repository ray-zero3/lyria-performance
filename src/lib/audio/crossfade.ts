import { clamp01 } from "$lib/telemetry/contract";

/** equal-power（定パワー）クロスフェードのゲイン対。out²+in²≈1。 */
export function equalPowerGains(t: number): { out: number; incoming: number } {
  const c = clamp01(t);
  return {
    out: Math.cos((c * Math.PI) / 2),
    incoming: Math.sin((c * Math.PI) / 2),
  };
}

export type TransitionPhase = "lead" | "fade" | "tail" | "done";

export interface TransitionPlan {
  leadMs: number;
  fadeMs: number;
  tailMs: number;
  wetPeak: number; // 0..1
}

export interface TransitionState {
  phase: TransitionPhase;
  outGain: number; // 0..1（旧セッション）
  inGain: number; // 0..1（新セッション）
  wet: number; // 0..1（リバーブ送り）
  muteDrumsOut: boolean;
  muteDrumsIn: boolean;
  progress: number; // FADE の進捗 0..1
}

/**
 * トランジション全体（LEAD→FADE→TAIL→done）を elapsed から純粋に決める。
 * drum mute フラグは「理想の目標」。実際の setConfig 適用は rotation が離散点で行う。
 */
export function transitionEnvelope(elapsedMs: number, plan: TransitionPlan): TransitionState {
  const { leadMs, fadeMs, tailMs, wetPeak } = plan;
  const e = elapsedMs < 0 ? 0 : elapsedMs;
  const fadeStart = leadMs;
  const fadeEnd = leadMs + fadeMs;
  const tailEnd = fadeEnd + tailMs;

  if (e < fadeStart) {
    const w = leadMs > 0 ? (e / leadMs) * wetPeak : wetPeak;
    return {
      phase: "lead",
      outGain: 1,
      inGain: 0,
      wet: w,
      muteDrumsOut: true,
      muteDrumsIn: true,
      progress: 0,
    };
  }
  if (e < fadeEnd) {
    const t = fadeMs > 0 ? (e - fadeStart) / fadeMs : 1;
    const g = equalPowerGains(t);
    return {
      phase: "fade",
      outGain: g.out,
      inGain: g.incoming,
      wet: wetPeak,
      muteDrumsOut: true,
      muteDrumsIn: true,
      progress: t,
    };
  }
  if (e < tailEnd) {
    const t = tailMs > 0 ? (e - fadeEnd) / tailMs : 1;
    return {
      phase: "tail",
      outGain: 0,
      inGain: 1,
      wet: wetPeak * (1 - t),
      muteDrumsOut: true,
      muteDrumsIn: false,
      progress: 1,
    };
  }
  return {
    phase: "done",
    outGain: 0,
    inGain: 1,
    wet: 0,
    muteDrumsOut: true,
    muteDrumsIn: false,
    progress: 1,
  };
}
