import type { TelemetryTransport } from "$lib/telemetry/bus";
import type { HubState, WeightedPrompt, TelemetryEvent } from "$lib/telemetry/contract";
import {
  DURATION_CAP_MS,
  ROTATE_AT_MS,
  CROSSFADE_LEAD_MS,
  CROSSFADE_FADE_MS,
  CROSSFADE_TAIL_MS,
  CHAOS_PEAK,
  INCOMING_AUDIO_TIMEOUT_MS,
} from "$lib/telemetry/constants";
import { makeDummyFrame, dummyStateAt } from "$lib/telemetry/dummy";
import { createAnalyser, type FrameAnalyser } from "./analyser";
import { createTestSource, createMicSource, type AudioSource } from "./sources";
import { base } from "$app/paths";
import { createMasterFx, type MasterFx, type MasterFxName } from "./masterFx";
import {
  concealDecision,
  createConcealNode,
  initConcealState,
  peakOf,
  CONCEAL_FADE_IN_S,
  CONCEAL_FADE_OUT_S,
  type ConcealState,
} from "./conceal";
import { createPcmPlayer } from "$lib/lyria/player";
import { createMockLyria } from "$lib/lyria/mock";
import { createLyriaSession } from "$lib/lyria/session";
import { defaultLyriaConfig, type LyriaMusicConfig } from "$lib/lyria/config";
import {
  createRotatingSource,
  type Deck,
  type RotatingSource,
} from "$lib/lyria/rotation";

export type SourceKind = "dummy" | "test" | "mic" | "mocklyria" | "lyria";

/** 現在セッションのタイミング（control 窓の残り時間表示用）。 */
export interface SessionTiming {
  /** 現在の active デッキが始まった時刻。 */
  activeStartedMs: number;
  /** 自動ローテーション予定時刻（この時刻に次セッションへ切り替わる）。 */
  rotateAtMs: number;
  /** クロスフェード進行中か。 */
  transitioning: boolean;
}

export interface AudioDriver {
  stop(): void;
  setPrompts(p: WeightedPrompt[]): void;
  setConfig(c: LyriaMusicConfig): void;
  resetContext(): void;
  rotate(): void;
  /** カオスマクロ 0..1（マスターFXを一括駆動。非 lyria は no-op）。 */
  setChaos(v: number): void;
  /** 各マスターFXの個別 base 0..1（非 lyria は no-op）。 */
  setFx(name: MasterFxName, v: number): void;
  /**
   * 現在セッションのタイミング。ローテーションを持つ音源（lyria / mocklyria）以外は null。
   * rotate() や自動ローテで active が入れ替わると activeStartedMs が更新される。
   */
  sessionTiming(): SessionTiming | null;
}

/** Lyria 音源時に「実際に送っている prompt/config」を反映した HubState（VJ の読めるデータ層用）。 */
function lyriaHubState(
  startedAtMs: number,
  prompts: WeightedPrompt[],
  config: LyriaMusicConfig,
  transition: { active: boolean; progress: number; chaos: number },
): HubState {
  const controlParams: Record<string, number> = {
    bpm: config.bpm,
    guidance: config.guidance,
    density: config.density,
    brightness: config.brightness,
    temperature: config.temperature,
  };
  if (transition.active) {
    controlParams.transitionProgress = transition.progress;
    controlParams.chaos = transition.chaos;
  }
  return {
    session: {
      id: "lyria",
      state: transition.active ? "rotating" : "playing",
      startedAtMs,
      durationCapMs: DURATION_CAP_MS,
      rotateAtMs: startedAtMs + ROTATE_AT_MS,
    },
    music: {
      bpm: config.bpm,
      scale: "auto",
      guidance: config.guidance,
      density: config.density,
      brightness: config.brightness,
    },
    prompts,
    controlParams,
  };
}

/**
 * 音源に応じて解析/ダミー/Lyria(モック含む) ループを回し、transport へ frame/state/event を送る。
 * lyria/mocklyria: 2デッキ + マスターFXバスでローテーション。PCM → player → deck gain → preMaster
 * → (dry/reverb) → master → destination/analyser。state は実 prompt/config とトランジション情報を反映。
 */
export async function startAudioDriver(opts: {
  source: SourceKind;
  transport: TelemetryTransport;
  onFps?: (n: number) => void;
  /** 緊急回避（コンシール）モードの ON/OFF 通知（control UI 表示用）。 */
  onConceal?: (active: boolean) => void;
  apiKey?: string;
  prompts?: WeightedPrompt[];
  config?: LyriaMusicConfig;
}): Promise<AudioDriver> {
  const { source, transport, onFps } = opts;
  const startedAtMs = Date.now();
  const isLyria = source === "lyria" || source === "mocklyria";
  let curPrompts: WeightedPrompt[] = opts.prompts ?? [{ text: "ambient pads", weight: 1 }];
  let curConfig: LyriaMusicConfig = opts.config ?? defaultLyriaConfig();
  let seq = 0;
  let raf = 0;
  let running = true;
  let frames = 0;
  let lastFpsT = performance.now();

  let ctx: AudioContext | null = null;
  let analyser: FrameAnalyser | null = null;
  let src: AudioSource | null = null;
  let masterFx: MasterFx | null = null;
  let rotation: RotatingSource | null = null;
  let transition = { active: false, progress: 0, chaos: 0 };

  // 緊急回避（コンシール）: preGain（Lyria 合流バス）→ concealNode → masterFx.input。
  // rawAnalyser で生レベルを観測し、瞬断で自動的に逆再生グラニュラーへ、復帰でフェード。
  let concealNode: AudioWorkletNode | null = null;
  let concealParam: AudioParam | null = null;
  let rawAnalyser: AnalyserNode | null = null;
  let rawTime: Float32Array | null = null;
  let concealState: ConcealState = initConcealState();
  let concealTarget: 0 | 1 = 0;
  let lastConcealMs = startedAtMs;

  const pushState = () => {
    if (isLyria) {
      transport.setState(
        lyriaHubState(
          rotation?.activeStartedMs() ?? startedAtMs,
          curPrompts,
          curConfig,
          transition,
        ),
      );
    } else {
      transport.setState(dummyStateAt(startedAtMs, Date.now()));
    }
  };

  if (source === "test" || source === "mic") {
    ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    src = source === "mic" ? await createMicSource(ctx) : createTestSource(ctx);
    analyser = createAnalyser(ctx, src.node);
  } else if (isLyria) {
    ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    masterFx = await createMasterFx(ctx, {
      workletUrl: `${base}/worklets/beat-repeat.js`,
    });
    masterFx.setBpm(curConfig.bpm);
    masterFx.output.connect(ctx.destination); // 出音
    analyser = createAnalyser(ctx, masterFx.output); // 解析（FX 込みの実出力）

    // 緊急回避チェーン: 全デッキ → preGain（合流バス）→ concealNode → masterFx.input。
    // rawAnalyser は preGain（リバーブ前の生 Lyria）に付け、瞬断検知に使う。
    const preGain = ctx.createGain();
    try {
      concealNode = await createConcealNode(ctx, `${base}/worklets/conceal.js`);
      preGain.connect(concealNode);
      concealNode.connect(masterFx.input);
      concealParam = concealNode.parameters.get("conceal") ?? null;
    } catch (e) {
      // ワークレット不成立時は素通し（preGain → masterFx 直結）
      console.error("[driver] conceal worklet 構築失敗（緊急回避なしで継続）:", e);
      preGain.connect(masterFx.input);
      concealNode = null;
    }
    rawAnalyser = ctx.createAnalyser();
    rawAnalyser.fftSize = 256;
    rawTime = new Float32Array(rawAnalyser.fftSize);
    preGain.connect(rawAnalyser);

    // 実デッキ = session + player + gain。onChunk 到達で hasAudio=true。
    const makeDeck = (): Deck => {
      const gain = ctx!.createGain();
      gain.gain.value = 0;
      gain.connect(preGain);
      const player = createPcmPlayer(ctx!);
      player.connect(gain);
      let gotAudio = false;
      const cbs = {
        onChunk: (b: Uint8Array) => {
          gotAudio = true;
          player.pushChunkBytes(b);
        },
        onEvent: (e: TelemetryEvent) => transport.pushEvent(e),
      };
      const session =
        source === "lyria"
          ? createLyriaSession(opts.apiKey ?? "", cbs)
          : createMockLyria(cbs);
      return {
        setPrompts: (p) => session.setPrompts(p),
        setConfig: (c) => session.setConfig(c),
        resetContext: () => session.resetContext(),
        setGain: (v) => {
          gain.gain.value = v;
        },
        hasAudio: () => gotAudio,
        start: () => session.start(),
        stop: () => {
          session.stop();
          player.stop();
          try {
            gain.disconnect();
          } catch {
            /* ignore */
          }
        },
      };
    };

    rotation = createRotatingSource({
      factory: { create: makeDeck },
      plan: {
        leadMs: CROSSFADE_LEAD_MS,
        fadeMs: CROSSFADE_FADE_MS,
        tailMs: CROSSFADE_TAIL_MS,
        wetPeak: CHAOS_PEAK,
      },
      now: () => Date.now(),
      initialPrompts: curPrompts,
      initialConfig: curConfig,
      autoRotateMs: ROTATE_AT_MS,
      incomingTimeoutMs: INCOMING_AUDIO_TIMEOUT_MS,
      onChaos: (c) => masterFx?.setChaos(c),
      onTransition: (s) => {
        transition = {
          active: s.active,
          progress: s.state?.progress ?? 0,
          chaos: s.state?.wet ?? 0,
        };
      },
    });
    await rotation.start();
  }

  pushState(); // 初期 state（rotation 生成後）

  const loop = () => {
    if (!running) return;
    const now = Date.now();
    rotation?.tick(now);

    // 緊急回避: 生レベルを観測 → 判定 → conceal パラメータをフェード自動化。
    if (concealParam && rawAnalyser && rawTime && ctx) {
      rawAnalyser.getFloatTimeDomainData(rawTime);
      const peak = peakOf(rawTime);
      const dt = now - lastConcealMs;
      lastConcealMs = now;
      const { state, target } = concealDecision(concealState, peak, dt);
      concealState = state;
      if (target !== concealTarget) {
        const t = ctx.currentTime;
        const fade = target > concealTarget ? CONCEAL_FADE_IN_S : CONCEAL_FADE_OUT_S;
        concealParam.cancelScheduledValues(t);
        concealParam.setValueAtTime(concealParam.value, t);
        concealParam.linearRampToValueAtTime(target, t + fade);
        concealTarget = target;
        opts.onConceal?.(target === 1); // control UI へ ON/OFF 通知
      }
    }

    seq += 1;
    const frame =
      analyser != null
        ? analyser.readFrame(seq, now - startedAtMs)
        : makeDummyFrame(seq, now - startedAtMs);
    transport.pushFrame(frame);
    if (seq % 30 === 0) pushState();
    frames++;
    const pt = performance.now();
    if (pt - lastFpsT >= 1000) {
      onFps?.(frames);
      frames = 0;
      lastFpsT = pt;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      rotation?.stop();
      analyser?.dispose();
      src?.dispose();
      try {
        concealNode?.disconnect();
        rawAnalyser?.disconnect();
      } catch {
        /* ignore */
      }
      masterFx?.dispose();
      if (ctx) void ctx.close();
    },
    setPrompts(p: WeightedPrompt[]) {
      curPrompts = p;
      rotation?.setPrompts(p);
      pushState();
    },
    setConfig(c: LyriaMusicConfig) {
      curConfig = c;
      rotation?.setConfig(c);
      masterFx?.setBpm(c.bpm); // ビートリピートのスライス長を bpm に追従
      pushState();
    },
    resetContext() {
      rotation?.resetContext();
    },
    rotate() {
      rotation?.rotate();
    },
    setChaos(v: number) {
      masterFx?.setChaos(v);
    },
    setFx(name: MasterFxName, v: number) {
      masterFx?.setBase(name, v);
    },
    sessionTiming() {
      if (!rotation) return null;
      const activeStartedMs = rotation.activeStartedMs();
      return {
        activeStartedMs,
        rotateAtMs: activeStartedMs + ROTATE_AT_MS,
        transitioning: rotation.isTransitioning(),
      };
    },
  };
}
