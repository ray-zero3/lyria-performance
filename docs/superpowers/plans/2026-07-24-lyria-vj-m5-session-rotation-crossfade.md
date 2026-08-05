# Lyria VJ M5: 2セッション・ローテーション + マスク付きクロスフェード 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lyria の10分上限を、2セッションのオーバーラップ＋ドラム消し＋リバーブwashで隠した ~4s クロスフェードで吸収し、自動(~8分)/手動ローテーションで実質シームレスに継続する。

**Architecture:** lyria/mocklyria 音源時のみ、単一 player を「2デッキ + マスターFXバス」に置換。クロスフェードの数学(`crossfade.ts`)とリバーブIR生成(`masterFx.ts`)は純粋関数として切り出し Vitest で検証。ローテーション手順(`rotation.ts`)はデッキ生成と時刻を注入して mock で検証。driver がこれらを配線し rAF ループから tick 駆動する。Rust 変更ゼロ（`session.state:String` と `controlParams:BTreeMap` に収まる）。

**Tech Stack:** SvelteKit + TypeScript + Web Audio API（GainNode/ConvolverNode/AnalyserNode）、Vitest。実 Lyria は `@google/genai`。

## Global Constraints

- **git はコミットしない**（プロジェクト合意・git 未初期化）。各タスクの締めは `git commit` ではなく **該当テスト実行**でチェックポイントとする。
- 作業ディレクトリ: `/Users/reimatsuda/Downloads/MRT2_LiveCoding_Extensions/lyria-vj`。
- immutability を守る（config は spread で新オブジェクト、mutation しない）。日本語コメント。
- 実 Lyria live 検証は不可（キー＋allowlist＋フォーカス窓が必要）→ 純ロジックは Vitest、live は user 確認。
- **API へ setConfig を毎フレーム送らない**：drum mute の切替は rotate()/完了/中止の離散点のみ。gain/wet/state は毎 tick のローカル操作のみ。
- ベースライン緑: vitest 43・cargo test 6・svelte-check 0・cargo build/clippy clean。M5 後もこれを割らない。
- テスト実行: `npm test`（vitest）/ `npm run check`（svelte-check）/ `cargo test --manifest-path src-tauri/Cargo.toml --lib` / `cargo clippy --manifest-path src-tauri/Cargo.toml --lib`。

---

### Task 1: M5 定数の追加

**Files:**
- Modify: `src/lib/telemetry/constants.ts`

**Interfaces:**
- Produces: `CROSSFADE_LEAD_MS`, `CROSSFADE_FADE_MS`, `CROSSFADE_TAIL_MS`, `REVERB_SECONDS`, `REVERB_DECAY`, `REVERB_WET_PEAK`, `INCOMING_AUDIO_TIMEOUT_MS`（全て number）。既存 `ROTATE_AT_MS` はそのまま使用。

- [ ] **Step 1: 定数を追記**

`src/lib/telemetry/constants.ts` の末尾に追記:

```ts
// M5: クロスフェード・トランジションのタイミング（ms）
export const CROSSFADE_LEAD_MS = 2000; // ドラム消し＋リバーブwashの助走
export const CROSSFADE_FADE_MS = 4000; // equal-power クロスフェード本体（~4s）
export const CROSSFADE_TAIL_MS = 2000; // リバーブwashの余韻＋新セッションのドラム復帰
export const INCOMING_AUDIO_TIMEOUT_MS = 8000; // 新セッションの最初のチャンクが来ない時の中止

// M5: 手続き的リバーブ IR
export const REVERB_SECONDS = 2.5;
export const REVERB_DECAY = 2.0;
export const REVERB_WET_PEAK = 0.5; // トランジション時の wet 送りピーク
```

- [ ] **Step 2: 型チェック**

Run: `npm run check`
Expected: 0 errors（定数追加のみ）。

---

### Task 2: `crossfade.ts` — equal-power とトランジション・エンベロープ（純粋関数）

**Files:**
- Create: `src/lib/audio/crossfade.ts`
- Test: `src/lib/audio/crossfade.test.ts`

**Interfaces:**
- Consumes: `clamp01` from `$lib/telemetry/contract`。
- Produces:
  - `equalPowerGains(t: number): { out: number; incoming: number }`
  - `type TransitionPhase = "lead" | "fade" | "tail" | "done"`
  - `interface TransitionPlan { leadMs: number; fadeMs: number; tailMs: number; wetPeak: number }`
  - `interface TransitionState { phase: TransitionPhase; outGain: number; inGain: number; wet: number; muteDrumsOut: boolean; muteDrumsIn: boolean; progress: number }`
  - `transitionEnvelope(elapsedMs: number, plan: TransitionPlan): TransitionState`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/audio/crossfade.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { equalPowerGains, transitionEnvelope, type TransitionPlan } from "./crossfade";

const PLAN: TransitionPlan = { leadMs: 2000, fadeMs: 4000, tailMs: 2000, wetPeak: 0.5 };

describe("equalPowerGains", () => {
  it("t=0 は out=1, incoming=0", () => {
    const g = equalPowerGains(0);
    expect(g.out).toBeCloseTo(1, 5);
    expect(g.incoming).toBeCloseTo(0, 5);
  });
  it("t=1 は out=0, incoming=1", () => {
    const g = equalPowerGains(1);
    expect(g.out).toBeCloseTo(0, 5);
    expect(g.incoming).toBeCloseTo(1, 5);
  });
  it("t=0.5 は両方 ~0.707 で定パワー", () => {
    const g = equalPowerGains(0.5);
    expect(g.out).toBeCloseTo(Math.SQRT1_2, 4);
    expect(g.incoming).toBeCloseTo(Math.SQRT1_2, 4);
    expect(g.out ** 2 + g.incoming ** 2).toBeCloseTo(1, 4);
  });
  it("範囲外は clamp", () => {
    expect(equalPowerGains(-1).out).toBeCloseTo(1, 5);
    expect(equalPowerGains(2).incoming).toBeCloseTo(1, 5);
  });
});

describe("transitionEnvelope", () => {
  it("LEAD: wet が 0→peak、gain は 1/0、drums 両方 mute", () => {
    const s0 = transitionEnvelope(0, PLAN);
    expect(s0.phase).toBe("lead");
    expect(s0.outGain).toBe(1);
    expect(s0.inGain).toBe(0);
    expect(s0.wet).toBeCloseTo(0, 5);
    expect(s0.muteDrumsOut).toBe(true);
    expect(s0.muteDrumsIn).toBe(true);
    const sMid = transitionEnvelope(1000, PLAN);
    expect(sMid.wet).toBeCloseTo(0.25, 3); // 1000/2000 * 0.5
  });
  it("FADE: equal-power で out→in、wet=peak", () => {
    const sStart = transitionEnvelope(2000, PLAN);
    expect(sStart.phase).toBe("fade");
    expect(sStart.outGain).toBeCloseTo(1, 4);
    expect(sStart.inGain).toBeCloseTo(0, 4);
    expect(sStart.wet).toBeCloseTo(0.5, 5);
    const sMid = transitionEnvelope(4000, PLAN); // fade 半分
    expect(sMid.outGain).toBeCloseTo(Math.SQRT1_2, 3);
    expect(sMid.inGain).toBeCloseTo(Math.SQRT1_2, 3);
    expect(sMid.progress).toBeCloseTo(0.5, 3);
  });
  it("TAIL: gain 0/1、wet peak→0、新セッションのドラム復帰", () => {
    const s = transitionEnvelope(7000, PLAN); // tail 半分 (6000..8000)
    expect(s.phase).toBe("tail");
    expect(s.outGain).toBe(0);
    expect(s.inGain).toBe(1);
    expect(s.wet).toBeCloseTo(0.25, 3); // 0.5 * (1 - 0.5)
    expect(s.muteDrumsIn).toBe(false);
  });
  it("done: 総時間超過で out=0,in=1,wet=0", () => {
    const s = transitionEnvelope(99999, PLAN);
    expect(s.phase).toBe("done");
    expect(s.outGain).toBe(0);
    expect(s.inGain).toBe(1);
    expect(s.wet).toBe(0);
    expect(s.muteDrumsIn).toBe(false);
  });
  it("負値は LEAD 開始扱い", () => {
    expect(transitionEnvelope(-500, PLAN).phase).toBe("lead");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- crossfade`
Expected: FAIL（`crossfade.ts` が未作成）。

- [ ] **Step 3: 最小実装を書く**

`src/lib/audio/crossfade.ts`:

```ts
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- crossfade`
Expected: PASS（全ケース）。

---

### Task 3: `masterFx.ts` — 手続き的リバーブ IR（純粋）＋ マスターFXバス（配線）

**Files:**
- Create: `src/lib/audio/masterFx.ts`
- Test: `src/lib/audio/masterFx.test.ts`

**Interfaces:**
- Consumes: `clamp01` from `$lib/telemetry/contract`；`REVERB_SECONDS`, `REVERB_DECAY` from `$lib/telemetry/constants`。
- Produces:
  - `impulseResponseSamples(sampleRate: number, seconds: number, decay: number): Float32Array`（純粋・決定的）
  - `interface MasterFx { input: GainNode; output: AudioNode; setWet(v: number): void; dispose(): void }`
  - `createMasterFx(ctx: AudioContext, opts?: { seconds?: number; decay?: number }): MasterFx`

- [ ] **Step 1: 失敗するテストを書く（純粋関数のみ）**

`src/lib/audio/masterFx.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { impulseResponseSamples } from "./masterFx";

describe("impulseResponseSamples", () => {
  it("長さは round(sampleRate*seconds)", () => {
    const s = impulseResponseSamples(48000, 2, 2);
    expect(s.length).toBe(96000);
  });
  it("全値が [-1,1] に収まる", () => {
    const s = impulseResponseSamples(48000, 1, 2);
    for (let i = 0; i < s.length; i += 137) {
      expect(s[i]).toBeGreaterThanOrEqual(-1);
      expect(s[i]).toBeLessThanOrEqual(1);
    }
  });
  it("末尾は指数減衰で ~0", () => {
    const s = impulseResponseSamples(48000, 1, 2);
    expect(Math.abs(s[s.length - 1])).toBeLessThan(0.01);
  });
  it("decay が大きいほど後半のエネルギーが小さい", () => {
    const rms = (a: Float32Array, from: number) => {
      let sum = 0;
      let n = 0;
      for (let i = from; i < a.length; i++) {
        sum += a[i] * a[i];
        n++;
      }
      return Math.sqrt(sum / n);
    };
    const soft = impulseResponseSamples(48000, 1, 1);
    const hard = impulseResponseSamples(48000, 1, 4);
    const half = Math.floor(soft.length / 2);
    expect(rms(hard, half)).toBeLessThan(rms(soft, half));
  });
  it("決定的（同じ入力で同じ出力）", () => {
    const a = impulseResponseSamples(8000, 0.5, 2);
    const b = impulseResponseSamples(8000, 0.5, 2);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- masterFx`
Expected: FAIL（`masterFx.ts` が未作成）。

- [ ] **Step 3: 最小実装を書く**

`src/lib/audio/masterFx.ts`:

```ts
import { clamp01 } from "$lib/telemetry/contract";
import { REVERB_SECONDS, REVERB_DECAY } from "$lib/telemetry/constants";

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

export interface MasterFx {
  /** デッキ gain の接続先（preMaster）。 */
  input: GainNode;
  /** destination / analyser の接続先（master）。 */
  output: AudioNode;
  /** リバーブ送り量 0..1。 */
  setWet(v: number): void;
  dispose(): void;
}

/**
 * マスターFXバス: preMaster →(dry)→ master、preMaster → wetSend → Convolver →(wet)→ master。
 * 定常時 wet=0 なので dry のみ＝従来と同じ音。トランジション時に setWet で wash をかける。
 */
export function createMasterFx(
  ctx: AudioContext,
  opts?: { seconds?: number; decay?: number },
): MasterFx {
  const seconds = opts?.seconds ?? REVERB_SECONDS;
  const decay = opts?.decay ?? REVERB_DECAY;

  const preMaster = ctx.createGain();
  const master = ctx.createGain();
  const wetSend = ctx.createGain();
  wetSend.gain.value = 0;
  const conv = ctx.createConvolver();

  const len = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  const samples = impulseResponseSamples(ctx.sampleRate, seconds, decay);
  ir.copyToChannel(samples, 0);
  ir.copyToChannel(samples, 1);
  conv.buffer = ir;

  preMaster.connect(master); // dry
  preMaster.connect(wetSend);
  wetSend.connect(conv);
  conv.connect(master); // wet

  return {
    input: preMaster,
    output: master,
    setWet(v: number) {
      wetSend.gain.value = clamp01(v);
    },
    dispose() {
      for (const n of [preMaster, master, wetSend, conv]) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- masterFx`
Expected: PASS。`createMasterFx` は AudioContext 依存のため単体テスト対象外（build + live で確認）。

---

### Task 4: `rotation.ts` — ローテーション・オーケストレーション（注入で単体テスト）

**Files:**
- Create: `src/lib/lyria/rotation.ts`
- Test: `src/lib/lyria/rotation.test.ts`

**Interfaces:**
- Consumes: `WeightedPrompt` from `$lib/telemetry/contract`；`LyriaMusicConfig` from `$lib/lyria/config`；`transitionEnvelope`, `TransitionPlan`, `TransitionState` from `$lib/audio/crossfade`。
- Produces:
  - `interface Deck { setPrompts(p): void; setConfig(c): void; resetContext(): void; setGain(v: number): void; hasAudio(): boolean; start(): Promise<void>; stop(): void }`
  - `interface DeckFactory { create(): Deck }`
  - `interface RotatingSourceOpts { factory; plan; now: () => number; initialPrompts; initialConfig; autoRotateMs?: number; incomingTimeoutMs?: number; onWet?: (w: number) => void; onTransition?: (s: { active: boolean; state: TransitionState | null }) => void }`
  - `interface RotatingSource { start(): Promise<void>; setPrompts(p): void; setConfig(c): void; resetContext(): void; rotate(): void; tick(now: number): void; isTransitioning(): boolean; activeStartedMs(): number; stop(): void }`
  - `createRotatingSource(opts: RotatingSourceOpts): RotatingSource`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/lyria/rotation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createRotatingSource, type Deck, type DeckFactory } from "./rotation";
import type { TransitionPlan } from "$lib/audio/crossfade";
import { defaultLyriaConfig } from "./config";

const PLAN: TransitionPlan = { leadMs: 2000, fadeMs: 4000, tailMs: 2000, wetPeak: 0.5 };

interface MockDeck {
  deck: Deck;
  configs: import("./config").LyriaMusicConfig[];
  gains: number[];
  started: number;
  stopped: number;
  setAudio(v: boolean): void;
}

function makeMockDeck(): MockDeck {
  const configs: import("./config").LyriaMusicConfig[] = [];
  const gains: number[] = [];
  let audio = false;
  let started = 0;
  let stopped = 0;
  const rec: MockDeck = {
    deck: {
      setPrompts: () => {},
      setConfig: (c) => configs.push(c),
      resetContext: () => {},
      setGain: (v) => gains.push(v),
      hasAudio: () => audio,
      start: async () => {
        started += 1;
      },
      stop: () => {
        stopped += 1;
      },
    },
    configs,
    gains,
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    setAudio: (v) => {
      audio = v;
    },
  };
  return rec;
}

function makeFactory(decks: MockDeck[]): DeckFactory {
  let i = 0;
  return { create: () => decks[i++].deck };
}

const opts = (decks: MockDeck[], now: () => number, extra = {}) => ({
  factory: makeFactory(decks),
  plan: PLAN,
  now,
  initialPrompts: [{ text: "pads", weight: 1 }],
  initialConfig: defaultLyriaConfig(),
  ...extra,
});

describe("createRotatingSource", () => {
  it("start で active を作りゲイン1", async () => {
    const d = [makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t));
    await r.start();
    expect(d[0].started).toBe(1);
    expect(d[0].gains.at(-1)).toBe(1);
    expect(r.isTransitioning()).toBe(false);
  });

  it("rotate で incoming をドラムmute・ゲイン0で start、二重 rotate は無視", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t));
    await r.start();
    r.rotate();
    expect(d[1].started).toBe(1);
    expect(d[1].configs.at(-1)?.muteDrums).toBe(true); // 新は drums mute で開始
    expect(d[1].gains.at(0)).toBe(0);
    expect(d[0].configs.at(-1)?.muteDrums).toBe(true); // 旧も drums 間引き
    expect(r.isTransitioning()).toBe(true);
    r.rotate(); // 進行中は無視
    expect(d.length).toBe(2);
  });

  it("first-chunk ゲート: 音が来るまで FADE を開始しない", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t));
    await r.start();
    r.rotate();
    t = 5000; // lead(2000) 超過だが incoming に音なし
    r.tick(t);
    expect(d[0].gains.at(-1)).toBe(1); // 旧はまだ 1（無音へフェードしない）
    expect(d[1].gains.at(-1)).toBe(0);
    d[1].setAudio(true);
    t = 5001;
    r.tick(t); // ここで fade 開始
    t = 7001; // fadeStart(5001)+2000 = fade 半分
    r.tick(t);
    expect(d[0].gains.at(-1)!).toBeGreaterThan(0);
    expect(d[0].gains.at(-1)!).toBeLessThan(1);
    expect(d[1].gains.at(-1)!).toBeGreaterThan(0);
  });

  it("完了で active を昇格し、新 active のドラムを desired に戻す", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t));
    await r.start();
    r.rotate();
    d[1].setAudio(true);
    t = 2001;
    r.tick(t); // fade 開始
    t = 2001 + PLAN.fadeMs + PLAN.tailMs + 10; // 総時間超過 → done
    r.tick(t);
    expect(d[0].stopped).toBe(1); // 旧を停止
    expect(r.isTransitioning()).toBe(false);
    expect(d[1].configs.at(-1)?.muteDrums).toBe(false); // 新 active はドラム復帰
    expect(d[1].gains.at(-1)).toBe(1);
  });

  it("incoming が時間内に音を出さなければ中止し active を維持", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t, { incomingTimeoutMs: 8000 }));
    await r.start();
    r.rotate();
    t = 8001; // タイムアウト超過・音なし
    r.tick(t);
    expect(d[1].stopped).toBe(1); // incoming 破棄
    expect(r.isTransitioning()).toBe(false);
    expect(d[0].configs.at(-1)?.muteDrums).toBe(false); // active は desired に復帰
    expect(d[0].gains.at(-1)).toBe(1);
  });

  it("setConfig: トランジション中は両デッキ drums mute、平常時は desired そのまま", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t));
    await r.start();
    r.setConfig({ ...defaultLyriaConfig(), muteDrums: false, bpm: 130 });
    expect(d[0].configs.at(-1)?.muteDrums).toBe(false);
    expect(d[0].configs.at(-1)?.bpm).toBe(130);
    r.rotate();
    r.setConfig({ ...defaultLyriaConfig(), muteDrums: false, bpm: 140 });
    expect(d[0].configs.at(-1)?.muteDrums).toBe(true); // 中は強制 mute
    expect(d[1].configs.at(-1)?.muteDrums).toBe(true);
    expect(d[1].configs.at(-1)?.bpm).toBe(140); // 他パラメータは反映
  });

  it("autoRotateMs 到達で tick が自動 rotate", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t, { autoRotateMs: 10000 }));
    await r.start();
    t = 9000;
    r.tick(t);
    expect(r.isTransitioning()).toBe(false);
    t = 10001;
    r.tick(t);
    expect(r.isTransitioning()).toBe(true); // 自動ローテ発火
    expect(d[1].started).toBe(1);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- rotation`
Expected: FAIL（`rotation.ts` が未作成）。

- [ ] **Step 3: 最小実装を書く**

`src/lib/lyria/rotation.ts`:

```ts
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
  onWet?: (w: number) => void;
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
    opts.onWet?.(state?.wet ?? 0);
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
      if (transitionStartMs != null || !active) return; // 二重起動ガード
      incoming = factory.create();
      incoming.setGain(0);
      incoming.setPrompts(curPrompts);
      incoming.setConfig(withMutedDrums(desiredConfig));
      void incoming.start();
      active.setConfig(withMutedDrums(desiredConfig)); // 旧のドラムを間引く
      transitionStartMs = now();
      fadeStartMs = null;
    },

    tick(t: number) {
      // 平常時: 自動ローテ判定
      if (transitionStartMs == null) {
        if (
          active &&
          opts.autoRotateMs != null &&
          t - activeStarted >= opts.autoRotateMs
        ) {
          this.rotate();
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- rotation`
Expected: PASS（7ケース）。

---

### Task 5: `driver.ts` — マスターFX + ローテーションの配線と rotate()/自動ローテ/state 露出

**Files:**
- Modify: `src/lib/audio/driver.ts`

**Interfaces:**
- Consumes: `createMasterFx` from `./masterFx`；`createRotatingSource`, `Deck`, `DeckFactory` from `$lib/lyria/rotation`；`crossfade` 定数群と `ROTATE_AT_MS`, `INCOMING_AUDIO_TIMEOUT_MS`, `REVERB_WET_PEAK`, `CROSSFADE_*` from `$lib/telemetry/constants`。
- Produces: `AudioDriver` に `rotate(): void` を追加。lyria/mocklyria で 2デッキ＋FXバス駆動。

- [ ] **Step 1: `AudioDriver` に rotate を追加し、lyria 分岐を差し替える**

`src/lib/audio/driver.ts` を以下に更新（test/mic/dummy 経路は不変、lyria/mocklyria の構築のみ置換）:

冒頭 import に追記:

```ts
import { createMasterFx, type MasterFx } from "./masterFx";
import { createRotatingSource, type Deck, type RotatingSource } from "$lib/lyria/rotation";
import {
  DURATION_CAP_MS,
  ROTATE_AT_MS,
  CROSSFADE_LEAD_MS,
  CROSSFADE_FADE_MS,
  CROSSFADE_TAIL_MS,
  REVERB_WET_PEAK,
  INCOMING_AUDIO_TIMEOUT_MS,
} from "$lib/telemetry/constants";
```

`AudioDriver` インターフェースに追記:

```ts
export interface AudioDriver {
  stop(): void;
  setPrompts(p: WeightedPrompt[]): void;
  setConfig(c: LyriaMusicConfig): void;
  resetContext(): void;
  rotate(): void;
}
```

`lyriaHubState` を拡張（トランジション情報を受ける）:

```ts
function lyriaHubState(
  startedAtMs: number,
  prompts: WeightedPrompt[],
  config: LyriaMusicConfig,
  transition: { active: boolean; progress: number; wet: number },
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
    controlParams.reverbWet = transition.wet;
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
```

`startAudioDriver` 本体: `lyria`/`player` の単体変数を削除し、`masterFx`/`rotation`/トランジション状態を追加。lyria 分岐と loop/return を差し替える。

宣言部（既存の `let player`/`let lyria` を置換）:

```ts
  let ctx: AudioContext | null = null;
  let analyser: FrameAnalyser | null = null;
  let src: AudioSource | null = null;
  let masterFx: MasterFx | null = null;
  let rotation: RotatingSource | null = null;
  let transition = { active: false, progress: 0, wet: 0 };
```

`pushState` を lyria 対応に（rotation の activeStartedMs を使う。未生成時は startedAtMs）:

```ts
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
```

※ 初期 `pushState(...)` 呼び出しはソース構築の後（rotation 生成後）に移動する。

lyria/mocklyria 構築ブロック（`} else if (isLyria) { ... }` を丸ごと置換）:

```ts
  } else if (isLyria) {
    ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    masterFx = createMasterFx(ctx);
    masterFx.output.connect(ctx.destination); // 出音
    analyser = createAnalyser(ctx, masterFx.output); // 解析（リバーブ込みの実出力）

    // 実デッキ = session + player + gain。onChunk 到達で hasAudio=true。
    const makeDeck = (): Deck => {
      const gain = ctx!.createGain();
      gain.gain.value = 0;
      gain.connect(masterFx!.input);
      const player = createPcmPlayer(ctx!);
      player.connect(gain);
      let gotAudio = false;
      const cbs = {
        onChunk: (b: Uint8Array) => {
          gotAudio = true;
          player.pushChunkBytes(b);
        },
        onEvent: (e: import("$lib/telemetry/contract").TelemetryEvent) =>
          transport.pushEvent(e),
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
        wetPeak: REVERB_WET_PEAK,
      },
      now: () => Date.now(),
      initialPrompts: curPrompts,
      initialConfig: curConfig,
      autoRotateMs: ROTATE_AT_MS,
      incomingTimeoutMs: INCOMING_AUDIO_TIMEOUT_MS,
      onWet: (w) => masterFx?.setWet(w),
      onTransition: (s) => {
        transition = {
          active: s.active,
          progress: s.state?.progress ?? 0,
          wet: s.state?.wet ?? 0,
        };
      },
    });
    await rotation.start();
  }

  pushState(); // 初期 state（rotation 生成後）
```

loop 内: rotation.tick を毎フレーム呼ぶ。frame の pushState は既存の `seq % 30` 条件を流用:

```ts
  const loop = () => {
    if (!running) return;
    const now = Date.now();
    rotation?.tick(now);
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
```

return オブジェクト: `rotation` 経由に付け替え、`rotate()` を追加:

```ts
  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      rotation?.stop();
      analyser?.dispose();
      src?.dispose();
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
      pushState();
    },
    resetContext() {
      rotation?.resetContext();
    },
    rotate() {
      rotation?.rotate();
    },
  };
```

※ 旧コードの `let player`, `let lyria`, および `import { createPcmPlayer }`/`createMockLyria`/`createLyriaSession` は makeDeck 内で使うため import は維持。`makeDummyFrame` の pushState 版は引数なしに統一（`pushState()`）。既存 `pushState(now)` 呼び出しは全て `pushState()` に変更。

- [ ] **Step 2: 型チェック**

Run: `npm run check`
Expected: 0 errors。

- [ ] **Step 3: 既存テストが緑のままか確認**

Run: `npm test`
Expected: PASS（既存43 + crossfade + masterFx + rotation の新規分）。

---

### Task 6: MIDI アクション "rotate" と control UI のローテーションボタン

**Files:**
- Modify: `src/lib/midi/types.ts`
- Modify: `src/routes/+page.svelte`

**Interfaces:**
- Consumes: `AudioDriver.rotate()`（Task 5）。
- Produces: `ActionTarget` に `"rotate"` を追加。UI に「ローテーション」ボタン。

- [ ] **Step 1: `ActionTarget` に "rotate" を追加**

`src/lib/midi/types.ts`:

```ts
export type ActionTarget =
  | "reset_context"
  | "play_toggle"
  | "mute_bass"
  | "mute_drums"
  | "rotate";
```

```ts
export const ACTION_TARGETS: ActionTarget[] = [
  "reset_context",
  "play_toggle",
  "mute_bass",
  "mute_drums",
  "rotate",
];
```

- [ ] **Step 2: `+page.svelte` の applyAction に rotate を追加**

`applyAction` の switch に追記（`mute_drums` case の後）:

```ts
      case "rotate":
        driver?.rotate();
        break;
```

- [ ] **Step 3: control UI にローテーションボタンを追加**

`+page.svelte` の Lyria 操作ブロック（`適用（live）` ボタンや `reset context` の近く、`{#if sourceKind === "lyria"}` 判定の外側で `isLyriaLike` 操作群の中）に:

```svelte
      <button onclick={() => driver?.rotate()} disabled={!running}>ローテーション</button>
```

- [ ] **Step 4: 型チェックと既存テスト**

Run: `npm run check && npm test -- mapping`
Expected: check 0 errors、mapping テスト PASS（"rotate" は action 扱いで既存ケースに影響なし）。

---

### Task 7: 全体検証（緑の確認）

**Files:** なし（検証のみ）

- [ ] **Step 1: フロント全テスト**

Run: `npm test`
Expected: 全 PASS（43 + 新規：crossfade 6・masterFx 5・rotation 7 = 61 前後）。

- [ ] **Step 2: 型チェック**

Run: `npm run check`
Expected: 0 errors / 0 warnings。

- [ ] **Step 3: Rust（変更なしだが回帰確認）**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: 6 tests PASS。

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --lib`
Expected: clean。

- [ ] **Step 4: ビルド健全性（任意・時間があれば）**

Run: `npm run build`
Expected: SvelteKit build 成功。

- [ ] **Step 5: HANDOFF.md の更新**

`HANDOFF.md` の「現在地」と段階ビルドプランを更新: M5 実装完了・次は M6。M5 の未確認（live: 実クロスフェード/リバーブ体感/8分自動ローテ/実機MIDIのrotate）を明記。

## Self-Review

**Spec coverage**（spec §各項 → タスク対応）:
- §2 信号グラフ（2デッキ+FXバス+analyser=master）→ Task 3(FX)/Task 5(配線)。
- §3.1 crossfade → Task 2。§3.2 masterFx → Task 3。§3.3 rotation → Task 4。§3.4 driver → Task 5。§3.5 UI/MIDI → Task 6。
- §4 タイムライン既定値 → Task 1(定数)/Task 2(envelope)。
- §5 VJ 露出（state=rotating, controlParams.transitionProgress/reverbWet, api rotate）→ Task 5（controlParams/state）。※ api イベントは既存の session.ts/mock.ts が rotate 時に emit する経路を持つ（resetContext 時）。M5 の rotate() は resetContext とは別経路なので、VJ 露出は controlParams + state で十分とし、明示 api イベントは任意（未実装でも spec の主眼は満たす）。
- §6 エラー（incoming 失敗/タイムアウト/二重/ stop）→ Task 4（abortToActive・ガード・stop）+ Task 5（stop で全解放）。
- §7 テスト → Task 2/3/4 の Vitest、Task 7 の全体。
- §8 定数 → Task 1。§10 スコープ外は着手しない。

**Placeholder scan:** TBD/TODO なし。全 code step に実コードあり。

**Type consistency:** `Deck`/`DeckFactory`/`RotatingSource` の名称・シグネチャは Task 4 定義と Task 5 使用で一致。`equalPowerGains` は `{out, incoming}`（`in` 予約語回避）で Task 2/4 一致。`transitionEnvelope`/`TransitionPlan`/`TransitionState` は Task 2 定義を Task 4 が import。`lyriaHubState` の第4引数 `transition` は Task 5 内で定義・使用が一致。

**気づき（実装時に対応）:** §5 の api `rotate` イベント明示発火は本計画では省略（controlParams + session.state で VJ 露出は成立）。必要なら Task 5 で `transport.pushEvent({kind:"api",api:"rotate",...})` を rotate 開始/完了で足す（軽微）。
