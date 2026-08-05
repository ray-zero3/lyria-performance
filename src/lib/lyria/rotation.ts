import type { WeightedPrompt } from "$lib/telemetry/contract";
import type { LyriaMusicConfig } from "./config";
import {
  transitionEnvelope,
  type TransitionPlan,
  type TransitionState,
} from "$lib/audio/crossfade";

/** ローテーションが扱う1セッション分（session + player + gain の束）。 */
export interface Deck {
  setPrompts(p: WeightedPrompt[]): void;
  setConfig(c: LyriaMusicConfig): void;
  resetContext(): void;
  setGain(v: number): void;
  hasAudio(): boolean;
  start(): Promise<void>;
  stop(): void;
}

export interface DeckFactory {
  create(): Deck;
}

export interface RotatingSourceOpts {
  factory: DeckFactory;
  plan: TransitionPlan;
  now: () => number;
  initialPrompts: WeightedPrompt[];
  initialConfig: LyriaMusicConfig;
  autoRotateMs?: number;
  incomingTimeoutMs?: number;
  /** トランジション強度（=カオス量）0..1。masterFx の setChaos へ渡す想定。 */
  onChaos?: (amount: number) => void;
  onTransition?: (s: { active: boolean; state: TransitionState | null }) => void;
}

export interface RotatingSource {
  start(): Promise<void>;
  setPrompts(p: WeightedPrompt[]): void;
  setConfig(c: LyriaMusicConfig): void;
  resetContext(): void;
  rotate(): void;
  tick(now: number): void;
  isTransitioning(): boolean;
  activeStartedMs(): number;
  stop(): void;
}

const withMutedDrums = (c: LyriaMusicConfig): LyriaMusicConfig => ({
  ...c,
  muteDrums: true,
});

/**
 * 2デッキ・オーバーラップのローテーション。drum mute の切替は rotate/完了/中止の
 * 離散点のみ（API へ setConfig を毎フレーム送らない）。gain/wet は tick でローカル操作。
 */
export function createRotatingSource(opts: RotatingSourceOpts): RotatingSource {
  const { factory, plan, now } = opts;
  const incomingTimeoutMs = opts.incomingTimeoutMs ?? 8000;

  let curPrompts = opts.initialPrompts;
  let desiredConfig = opts.initialConfig;
  let active: Deck | null = null;
  let incoming: Deck | null = null;
  let activeStarted = 0;
  let transitionStartMs: number | null = null;
  let fadeStartMs: number | null = null;

  const emit = (active_: boolean, state: TransitionState | null) => {
    opts.onTransition?.({ active: active_, state });
    opts.onChaos?.(state?.wet ?? 0); // envelope の wet(0→peak→0) をカオス量として供給
  };

  const abortToActive = () => {
    incoming?.stop();
    incoming = null;
    transitionStartMs = null;
    fadeStartMs = null;
    if (active) {
      active.setConfig(desiredConfig); // ドラム復帰
      active.setGain(1);
    }
    emit(false, null);
  };

  const promote = () => {
    active?.stop();
    active = incoming;
    incoming = null;
    transitionStartMs = null;
    fadeStartMs = null;
    activeStarted = now();
    if (active) {
      active.setConfig(desiredConfig); // 新 active のドラム復帰
      active.setGain(1);
    }
    emit(false, null);
  };

  const doRotate = () => {
    if (transitionStartMs != null || !active) return; // 二重起動ガード
    incoming = factory.create();
    incoming.setGain(0);
    incoming.setPrompts(curPrompts);
    incoming.setConfig(withMutedDrums(desiredConfig));
    void incoming.start();
    active.setConfig(withMutedDrums(desiredConfig)); // 旧のドラムを間引く
    transitionStartMs = now();
    fadeStartMs = null;
  };

  return {
    async start() {
      active = factory.create();
      active.setGain(1);
      active.setPrompts(curPrompts);
      active.setConfig(desiredConfig);
      activeStarted = now();
      await active.start();
    },

    setPrompts(p: WeightedPrompt[]) {
      curPrompts = p;
      active?.setPrompts(p);
      incoming?.setPrompts(p);
    },

    setConfig(c: LyriaMusicConfig) {
      desiredConfig = c;
      if (transitionStartMs != null) {
        active?.setConfig(withMutedDrums(c));
        incoming?.setConfig(withMutedDrums(c));
      } else {
        active?.setConfig(c);
      }
    },

    resetContext() {
      active?.resetContext();
    },

    rotate() {
      doRotate();
    },

    tick(t: number) {
      // 平常時: 自動ローテ判定
      if (transitionStartMs == null) {
        if (
          active &&
          opts.autoRotateMs != null &&
          t - activeStarted >= opts.autoRotateMs
        ) {
          doRotate();
        }
        return;
      }
      if (!active) return;

      const elapsed = t - transitionStartMs;

      if (fadeStartMs == null) {
        const leadDone = elapsed >= plan.leadMs;
        if (leadDone && incoming?.hasAudio()) {
          fadeStartMs = t; // ゲート解除→FADE 開始
        } else {
          // LEAD 中 or 音待ち: 旧を 1 に維持し wash だけ進める
          const leadElapsed = Math.min(elapsed, plan.leadMs);
          const wet =
            plan.leadMs > 0 ? (leadElapsed / plan.leadMs) * plan.wetPeak : plan.wetPeak;
          active.setGain(1);
          incoming?.setGain(0);
          emit(true, {
            phase: "lead",
            outGain: 1,
            inGain: 0,
            wet,
            muteDrumsOut: true,
            muteDrumsIn: true,
            progress: 0,
          });
          if (elapsed >= incomingTimeoutMs && !incoming?.hasAudio()) {
            abortToActive(); // 音が来ない → 中止して active 維持
          }
          return;
        }
      }

      // FADE/TAIL: fadeStartMs 起点。envelope の elapsed は lead 終了点から連続。
      const effElapsed = plan.leadMs + (t - fadeStartMs);
      const st = transitionEnvelope(effElapsed, plan);
      active.setGain(st.outGain);
      incoming?.setGain(st.inGain);
      emit(true, st);
      if (st.phase === "done") promote();
    },

    isTransitioning() {
      return transitionStartMs != null;
    },

    activeStartedMs() {
      return activeStarted;
    },

    stop() {
      active?.stop();
      active = null;
      incoming?.stop();
      incoming = null;
      transitionStartMs = null;
      fadeStartMs = null;
    },
  };
}
