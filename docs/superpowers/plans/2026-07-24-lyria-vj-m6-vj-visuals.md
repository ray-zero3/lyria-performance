# M6: VJ 本番ビジュアル（WebGPU/TSL・4シーン粒子世界）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **本プロジェクト特例**: git 未初期化（コミットしない合意）のため、各タスクの Commit ステップは「検証ステップ」に置換する。

**Goal:** M2〜M5b の使い捨てプレースホルダ VJ 描画を、音解析（onset/spectrum/bands/level/bpm）と session 状態（rotating/chaos）で駆動する 4 シーン（Vortex / RadialSpectrum / Terrain / Swarm）の本番粒子ビジュアルへ差し替える。

**Architecture:** 純粋関数層 `visualMapping`（frame+HubState→視覚パラメータ、Vitest）→ three 非依存の状態機械 `sceneManager`（シーン切替/フラッシュ/溶解→再結晶、Vitest）→ `scenes/`（TSL uniform 駆動の Sprite インスタンシング粒子、build/check で担保）→ `scene.ts` が配線。`dataLayer` が読めるデータ層を DOM オーバーレイで重ねる。

**Tech Stack:** three 0.185.1（`three/webgpu` + `three/tsl`）、SvelteKit、Vitest。

## Global Constraints

- three は **0.185.1**。TSL の import 元は `three/webgpu`（クラス）と `three/tsl`（ノード関数）。
- **WebGPU では `THREE.Points` は 1px 固定**（three 本体の JSDoc に明記）。サイズ付き粒子は **`THREE.Sprite` + `sprite.count`（WebGPU インスタンシング）+ `SpriteNodeMaterial`** を使う（`PointsNodeMaterial` の JSDoc が指示する公式手法）。
- 確認済み TSL export（`three.tsl.js` 実物で確認）: `Fn, uniform, uniformArray(.element/.array, updateType=RENDER), instanceIndex, hash, mx_noise_float, mx_noise_vec3, int, float, vec2, vec3, exp, abs, mod, floor, clamp, saturate, smoothstep, length, normalize, mix, sin, cos, PI2, uv, oneMinus`。
- **git コミットしない**。Rust 変更なし（フロントのみ）。
- immutability: 純粋層（visualMapping）は新オブジェクトを返す。three/uniform 境界の mutate は許容（既存パターン踏襲）。
- ベースライン緑を維持: vitest 73（+新規）/ svelte-check 0 errors / `npm run build` 成功 / cargo test 6 / clippy clean。
- 秘密情報（APIキー等）をログに出さない。

## File Structure

| ファイル | 役割 |
|---|---|
| Create `src/lib/vj/visualMapping.ts` | 純粋: onsetEnvelope / smoothSpectrum / bandsToColor / hslToRgb / secondaryColor / chaosToDissolve / motionSpeed / VisualParams 型 |
| Create `src/lib/vj/visualMapping.test.ts` | 上記のテスト（TDD） |
| Create `src/lib/vj/sceneManager.ts` | three 非依存の状態機械: シーン一覧/next/setScene/フラッシュ/溶解→再結晶/autoSwitch |
| Create `src/lib/vj/sceneManager.test.ts` | 注入 ManagedScene での呼び出し順検証（TDD） |
| Create `src/lib/vj/scenes/types.ts` | SceneContext / SceneImpl（init/update/setDissolve/flash/dispose） |
| Create `src/lib/vj/scenes/sceneUtils.ts` | 共通 uniforms 束・applyVisualParams・Sprite/マテリアル生成ヘルパ |
| Create `src/lib/vj/scenes/vortex.ts` | 渦 flow field 粒子 |
| Create `src/lib/vj/scenes/radialSpectrum.ts` | 48 セクタ同心リング + onset 衝撃波 |
| Create `src/lib/vj/scenes/terrain.ts` | spectrum 変位の高さ場 + カメラドリフト + onset リップル |
| Create `src/lib/vj/scenes/swarm.ts` | アトラクタ群れ（boids 簡略・uniform 駆動） |
| Create `src/lib/vj/dataLayer.ts` | 読めるデータ層（prompt/bpm/state/progress/波形リボン canvas） |
| Modify `src/lib/vj/renderer.ts` | OrthographicCamera → PerspectiveCamera、aspect resize、背景色 |
| Rewrite `src/lib/vj/scene.ts` | store→visualMapping→sceneManager→現シーン update の配線 |
| Delete `src/lib/vj/layers/`（5ファイル） | プレースホルダ撤去（backgroundPulse/waveformRibbon/controlFlashes/timeline/readouts） |
| Modify `src/lib/midi/types.ts` | ActionTarget に `scene_next` |
| Modify `src/routes/+page.svelte` | applyAction の `scene_next` 分岐＋「シーン切替」ボタン |
| Modify `src/routes/vj/+page.svelte` | overlay の #tl/#ro を撤去（dataLayer が自前 DOM 構築） |

**シーン切替の伝搬**: control 窓（MIDI/ボタン）→ `TelemetryEvent{kind:"control", ctrl:"param", id:"scene_next"}` を pushEvent → VJ 窓の scene.ts がイベントリングを監視して `manager.next()`。

---

### Task 1: visualMapping（純粋・TDD）

**Files:**
- Create: `src/lib/vj/visualMapping.ts`
- Test: `src/lib/vj/visualMapping.test.ts`

**Interfaces:**
- Consumes: `clamp01`（`$lib/telemetry/contract`）、`SPECTRUM_BINS`（`$lib/telemetry/constants`）
- Produces: `onsetEnvelope(prev: number, onset: number, dtMs: number): number` / `smoothSpectrum(prev: readonly number[], next: readonly number[], dtMs: number): number[]` / `bandsToColor(bands: Bands): Hsl` / `hslToRgb(h,s,l): Rgb` / `secondaryColor(hsl: Hsl): Rgb` / `chaosToDissolve(chaos: number): number` / `motionSpeed(bpm: number): number` / `interface VisualParams { burst; spectrum; level; bands; colorA; colorB; speed }`

- [x] **Step 1: 失敗するテストを書く**（`src/lib/vj/visualMapping.test.ts`）

```ts
import { describe, it, expect } from "vitest";
import {
  onsetEnvelope, smoothSpectrum, bandsToColor, hslToRgb, secondaryColor,
  chaosToDissolve, motionSpeed, ONSET_DECAY_MS, SPEED_MAX, SPEED_MIN,
} from "./visualMapping";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";

describe("onsetEnvelope", () => {
  it("アタックは即時に onset 値へ跳ねる", () => {
    expect(onsetEnvelope(0, 0.8, 16)).toBeCloseTo(0.8);
  });
  it("減衰中でも大きい onset が来れば上書きされる", () => {
    expect(onsetEnvelope(0.3, 0.9, 16)).toBeCloseTo(0.9);
  });
  it("onset が無ければ指数減衰する（時定数で 1/e）", () => {
    expect(onsetEnvelope(0.8, 0, ONSET_DECAY_MS)).toBeCloseTo(0.8 / Math.E, 5);
  });
  it("連続フレームで単調減少する", () => {
    let v = 0.9;
    for (let i = 0; i < 10; i++) {
      const nv = onsetEnvelope(v, 0, 50);
      expect(nv).toBeLessThan(v);
      v = nv;
    }
  });
  it("dt=0 では減衰しない", () => {
    expect(onsetEnvelope(0.5, 0, 0)).toBeCloseTo(0.5);
  });
  it("不正値は clamp される（0..1）", () => {
    expect(onsetEnvelope(5, 2, 16)).toBe(1);
    expect(onsetEnvelope(NaN, NaN, NaN)).toBe(0);
  });
});

describe("smoothSpectrum", () => {
  const zeros = new Array<number>(SPECTRUM_BINS).fill(0);
  const ones = new Array<number>(SPECTRUM_BINS).fill(1);
  it("常に長さ SPECTRUM_BINS の新配列を返す（入力が空でも）", () => {
    expect(smoothSpectrum([], [], 16)).toHaveLength(SPECTRUM_BINS);
  });
  it("dt が大きいほど next へ収束する", () => {
    expect(smoothSpectrum(zeros, ones, 100000)[0]).toBeCloseTo(1, 3);
  });
  it("dt=0 なら prev を維持する", () => {
    const prev = zeros.map((_, i) => i / SPECTRUM_BINS);
    expect(smoothSpectrum(prev, ones, 0)[10]).toBeCloseTo(prev[10]);
  });
  it("prev を変異しない（イミュータブル）", () => {
    const prev = new Array<number>(SPECTRUM_BINS).fill(0.5);
    smoothSpectrum(prev, ones, 50);
    expect(prev.every((v) => v === 0.5)).toBe(true);
  });
  it("範囲外の入力は 0..1 に clamp される", () => {
    const out = smoothSpectrum(zeros, new Array<number>(SPECTRUM_BINS).fill(9), 100000);
    expect(Math.max(...out)).toBeLessThanOrEqual(1);
  });
});

describe("bandsToColor / hslToRgb / secondaryColor", () => {
  it("h/s/l は 0..1 に収まる", () => {
    const cases = [
      { low: 0, mid: 0, high: 0 },
      { low: 1, mid: 1, high: 1 },
      { low: 1, mid: 0, high: 0 },
      { low: 0, mid: 0, high: 1 },
    ];
    for (const b of cases) {
      const c = bandsToColor(b);
      for (const v of [c.h, c.s, c.l]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
  it("高域優勢は低域優勢より色相が進む", () => {
    expect(bandsToColor({ low: 0, mid: 0, high: 1 }).h).toBeGreaterThan(
      bandsToColor({ low: 1, mid: 0, high: 0 }).h,
    );
  });
  it("hslToRgb: 原色（赤）と無彩色", () => {
    const red = hslToRgb(0, 1, 0.5);
    expect(red.r).toBeCloseTo(1);
    expect(red.g).toBeCloseTo(0);
    expect(red.b).toBeCloseTo(0);
    const gray = hslToRgb(0.3, 0, 0.42);
    expect(gray.r).toBeCloseTo(0.42);
    expect(gray.g).toBeCloseTo(0.42);
  });
  it("secondaryColor はメイン色と十分離れる", () => {
    const hsl = bandsToColor({ low: 0.4, mid: 0.5, high: 0.2 });
    const a = hslToRgb(hsl.h, hsl.s, hsl.l);
    const b = secondaryColor(hsl);
    const d = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    expect(d).toBeGreaterThan(0.1);
  });
});

describe("chaosToDissolve", () => {
  it("0→0, 1→1", () => {
    expect(chaosToDissolve(0)).toBe(0);
    expect(chaosToDissolve(1)).toBe(1);
  });
  it("単調増加", () => {
    expect(chaosToDissolve(0.3)).toBeLessThan(chaosToDissolve(0.6));
  });
  it("範囲外は clamp", () => {
    expect(chaosToDissolve(-1)).toBe(0);
    expect(chaosToDissolve(2)).toBe(1);
  });
});

describe("motionSpeed", () => {
  it("基準 bpm(120) で 1.0", () => {
    expect(motionSpeed(120)).toBe(1);
  });
  it("bpm に比例（60→0.5）", () => {
    expect(motionSpeed(60)).toBe(0.5);
  });
  it("上下限にクランプ", () => {
    expect(motionSpeed(10000)).toBe(SPEED_MAX);
    expect(motionSpeed(1)).toBe(SPEED_MIN);
  });
  it("不正値（NaN/0/負）は 1", () => {
    expect(motionSpeed(NaN)).toBe(1);
    expect(motionSpeed(0)).toBe(1);
    expect(motionSpeed(-5)).toBe(1);
  });
});
```

- [x] **Step 2: RED 確認**

Run: `npm test -- src/lib/vj/visualMapping.test.ts`
Expected: FAIL（モジュール未作成）

- [x] **Step 3: 実装**（`src/lib/vj/visualMapping.ts`）

```ts
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

export interface Rgb { r: number; g: number; b: number; }
export interface Hsl { h: number; s: number; l: number; }
export interface Bands { low: number; mid: number; high: number; }

/** VJ シーンへ渡す 1 フレーム分の視覚パラメータ（純データ）。 */
export interface VisualParams {
  burst: number;               // onset エンベロープ 0..1
  spectrum: readonly number[]; // 平滑済み 48bin 0..1
  level: number;               // 0..1
  bands: Bands;
  colorA: Rgb;                 // メイン色（bands 由来）
  colorB: Rgb;                 // サブ色（補色系）
  speed: number;               // bpm テンポ係数
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
```

- [x] **Step 4: GREEN 確認**

Run: `npm test -- src/lib/vj/visualMapping.test.ts`
Expected: PASS（22 tests）

---

### Task 2: sceneManager（three 非依存の状態機械・TDD）

**Files:**
- Create: `src/lib/vj/sceneManager.ts`
- Test: `src/lib/vj/sceneManager.test.ts`

**Interfaces:**
- Consumes: `SessionState`（contract）、`VisualParams`・`clamp01`
- Produces: `interface ManagedScene { update(vp, dtMs); setDissolve(amount); flash(); }` / `createSceneManager(entries: readonly SceneEntry[], opts?): SceneManager` / `SceneManager { ids(); current(); next(); setScene(id); frame(vp, input, dtMs); dissolve(); flashRemainingMs(); }`

- [x] **Step 1: 失敗するテストを書く**（`src/lib/vj/sceneManager.test.ts`）

```ts
import { describe, it, expect } from "vitest";
import { createSceneManager, type ManagedScene } from "./sceneManager";
import type { VisualParams } from "./visualMapping";

function vp(): VisualParams {
  return {
    burst: 0,
    spectrum: new Array<number>(48).fill(0),
    level: 0.5,
    bands: { low: 0.2, mid: 0.3, high: 0.1 },
    colorA: { r: 0.2, g: 0.4, b: 0.9 },
    colorB: { r: 0.8, g: 0.3, b: 0.6 },
    speed: 1,
  };
}

interface Recorder {
  scene: ManagedScene;
  updates: number[];
  dissolves: number[];
  flashes: number;
}
function recorder(): Recorder {
  const r: Recorder = {
    updates: [],
    dissolves: [],
    flashes: 0,
    scene: {
      update: (_vp, dt) => r.updates.push(dt),
      setDissolve: (a) => r.dissolves.push(a),
      flash: () => { r.flashes += 1; },
    },
  };
  return r;
}

function make(opts: Parameters<typeof createSceneManager>[1] = {}) {
  const a = recorder();
  const b = recorder();
  const c = recorder();
  const m = createSceneManager(
    [
      { id: "a", scene: a.scene },
      { id: "b", scene: b.scene },
      { id: "c", scene: c.scene },
    ],
    opts,
  );
  return { m, a, b, c };
}

describe("sceneManager", () => {
  it("シーン一覧と初期シーン", () => {
    const { m } = make();
    expect(m.ids()).toEqual(["a", "b", "c"]);
    expect(m.current()).toBe("a");
  });
  it("next() は巡回してラップする", () => {
    const { m } = make();
    m.next();
    expect(m.current()).toBe("b");
    m.next();
    expect(m.current()).toBe("c");
    m.next();
    expect(m.current()).toBe("a");
  });
  it("setScene は指定シーンへ。未知IDと同一IDは無視（flash 重複なし）", () => {
    const { m, c } = make();
    m.setScene("c");
    expect(m.current()).toBe("c");
    expect(c.flashes).toBe(1);
    m.setScene("zzz");
    expect(m.current()).toBe("c");
    m.setScene("c");
    expect(c.flashes).toBe(1);
  });
  it("手動切替は新シーンに flash を1回かける（カット+フラッシュ）", () => {
    const { m, b } = make();
    m.next();
    expect(b.flashes).toBe(1);
    expect(m.flashRemainingMs()).toBeGreaterThan(0);
  });
  it("frame は現在シーンだけを更新する", () => {
    const { m, a, b } = make();
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 16);
    expect(a.updates).toEqual([16]);
    expect(a.dissolves).toHaveLength(1);
    expect(b.updates).toHaveLength(0);
  });
  it("rotating 中は dissolveTarget へ単調に近づく", () => {
    const { m, a } = make();
    for (let i = 0; i < 30; i++) {
      m.frame(vp(), { sessionState: "rotating", dissolveTarget: 0.8 }, 100);
    }
    const ds = a.dissolves;
    expect(ds[ds.length - 1]).toBeGreaterThan(0.7);
    for (let i = 1; i < ds.length; i++) {
      expect(ds[i]).toBeGreaterThanOrEqual(ds[i - 1]);
    }
  });
  it("rotate 完了後は 0 へ戻る（再結晶）", () => {
    const { m } = make({ autoSwitchOnRotate: false });
    for (let i = 0; i < 20; i++) {
      m.frame(vp(), { sessionState: "rotating", dissolveTarget: 1 }, 100);
    }
    expect(m.dissolve()).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i++) {
      m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 100);
    }
    expect(m.dissolve()).toBeLessThan(0.05);
  });
  it("rotate 完了で自動的に次シーンへ（フラッシュ無しのシームレス切替）", () => {
    const { m, b } = make({ autoSwitchOnRotate: true });
    m.frame(vp(), { sessionState: "rotating", dissolveTarget: 1 }, 16);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 16);
    expect(m.current()).toBe("b");
    expect(b.flashes).toBe(0);
  });
  it("autoSwitchOnRotate=false なら rotate 完了でも同一シーン", () => {
    const { m } = make({ autoSwitchOnRotate: false });
    m.frame(vp(), { sessionState: "rotating", dissolveTarget: 1 }, 16);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 16);
    expect(m.current()).toBe("a");
  });
  it("フラッシュ残時間はフレームで減衰して 0 になる", () => {
    const { m } = make({ flashMs: 100 });
    m.next();
    expect(m.flashRemainingMs()).toBe(100);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 60);
    expect(m.flashRemainingMs()).toBe(40);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 60);
    expect(m.flashRemainingMs()).toBe(0);
  });
  it("空のシーン配列は例外", () => {
    expect(() => createSceneManager([])).toThrow();
  });
});
```

- [x] **Step 2: RED 確認**

Run: `npm test -- src/lib/vj/sceneManager.test.ts`
Expected: FAIL（モジュール未作成）

- [x] **Step 3: 実装**（`src/lib/vj/sceneManager.ts`）

```ts
import { clamp01, type SessionState } from "$lib/telemetry/contract";
import type { VisualParams } from "./visualMapping";

/** manager から見たシーン操作面（three 非依存）。 */
export interface ManagedScene {
  update(vp: VisualParams, dtMs: number): void;
  setDissolve(amount: number): void;
  flash(): void;
}

export interface SceneEntry {
  id: string;
  scene: ManagedScene;
}

export interface SceneManagerOptions {
  /** 手動切替フラッシュの継続時間（ms）。 */
  flashMs?: number;
  /** rotate 完了時に次シーンへ自動切替（溶解中に入れ替わるシームレス演出）。 */
  autoSwitchOnRotate?: boolean;
  /** 溶解の追従時定数（ms）。 */
  dissolveEaseMs?: number;
}

export interface SceneFrameInput {
  sessionState: SessionState;
  /** chaosToDissolve 済みの目標溶解量 0..1。 */
  dissolveTarget: number;
}

export interface SceneManager {
  ids(): readonly string[];
  current(): string;
  next(): void;
  setScene(id: string): void;
  frame(vp: VisualParams, input: SceneFrameInput, dtMs: number): void;
  dissolve(): number;
  flashRemainingMs(): number;
}

export const DEFAULT_FLASH_MS = 250;
export const DEFAULT_DISSOLVE_EASE_MS = 600;

/** シーン切替/フラッシュ/溶解→再結晶の状態機械。three 操作は ManagedScene 注入で分離。 */
export function createSceneManager(
  entries: readonly SceneEntry[],
  opts: SceneManagerOptions = {},
): SceneManager {
  if (entries.length === 0) throw new Error("sceneManager: シーンが空です");
  const flashMs = opts.flashMs ?? DEFAULT_FLASH_MS;
  const autoSwitch = opts.autoSwitchOnRotate ?? true;
  const easeMs = opts.dissolveEaseMs ?? DEFAULT_DISSOLVE_EASE_MS;

  let index = 0;
  let dissolve = 0;
  let flashLeft = 0;
  let wasRotating = false;

  const switchTo = (i: number, withFlash: boolean): void => {
    index = i;
    if (withFlash) {
      entries[index].scene.flash();
      flashLeft = flashMs;
    }
  };

  return {
    ids: () => entries.map((e) => e.id),
    current: () => entries[index].id,
    next() {
      switchTo((index + 1) % entries.length, true);
    },
    setScene(id: string) {
      const i = entries.findIndex((e) => e.id === id);
      if (i < 0 || i === index) return;
      switchTo(i, true);
    },
    frame(vp, input, dtMs) {
      const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
      const rotating = input.sessionState === "rotating";
      // rotate 完了エッジ → 再結晶（任意で次シーンへ。フラッシュ無し）
      if (wasRotating && !rotating && autoSwitch) {
        switchTo((index + 1) % entries.length, false);
      }
      wasRotating = rotating;
      // 溶解: rotating 中は target へ、それ以外は 0 へ指数追従（再結晶）
      const target = rotating ? clamp01(input.dissolveTarget) : 0;
      dissolve += (target - dissolve) * (1 - Math.exp(-dt / easeMs));
      flashLeft = Math.max(0, flashLeft - dt);
      const cur = entries[index].scene;
      cur.setDissolve(dissolve);
      cur.update(vp, dt);
    },
    dissolve: () => dissolve,
    flashRemainingMs: () => flashLeft,
  };
}
```

- [x] **Step 4: GREEN 確認**

Run: `npm test -- src/lib/vj/sceneManager.test.ts`
Expected: PASS（11 tests）。続けて `npm test` 全体 → 73 + 33 = 106 想定。

---

### Task 3: renderer の PerspectiveCamera 化＋シーン基盤（types / sceneUtils）

**Files:**
- Modify: `src/lib/vj/renderer.ts`
- Create: `src/lib/vj/scenes/types.ts`
- Create: `src/lib/vj/scenes/sceneUtils.ts`

**Interfaces:**
- Produces: `RendererBundle.camera: THREE.PerspectiveCamera` / `SceneContext { root: THREE.Group; camera: THREE.PerspectiveCamera }` / `SceneImpl extends ManagedScene { id; init(ctx); dispose(); }` / `createCommonUniforms()` → `CommonUniforms`（time/burst/level/low/mid/high/dissolve/flash/colorA/colorB/spectrum）/ `applyVisualParams(u, vp, dtMs)` / `createAdditiveSpriteMaterial()` / `createParticleSprite(material, count)`

- [x] **Step 1: renderer.ts のカメラを差し替え**

`OrthographicCamera(-1,1,1,-1,0,10)` を以下へ（型・resize・背景も変更）:

```ts
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030309);
// 粒子世界を見る透視カメラ（アクティブシーンが毎フレーム位置を所有する）
const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 60);
camera.position.set(0, 0, 3.4);

const resize = (nw: number, nh: number) => {
  renderer.setSize(nw, nh);
  camera.aspect = nh > 0 ? nw / nh : 1;
  camera.updateProjectionMatrix();
};
```

`RendererBundle.camera` の型を `THREE.PerspectiveCamera` に変更。

- [x] **Step 2: scenes/types.ts**

```ts
import type * as THREE from "three/webgpu";
import type { ManagedScene } from "../sceneManager";

/** シーンへ渡す three コンテキスト。root はシーン専有（表示切替は scene.ts が visible で制御）。 */
export interface SceneContext {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
}

/** 各 VJ シーンの実装面。ManagedScene（update/setDissolve/flash）＋ライフサイクル。 */
export interface SceneImpl extends ManagedScene {
  readonly id: string;
  init(ctx: SceneContext): void;
  dispose(): void;
}
```

- [x] **Step 3: scenes/sceneUtils.ts**

```ts
import * as THREE from "three/webgpu";
import { uniform, uniformArray } from "three/tsl";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";
import type { VisualParams } from "../visualMapping";

/** フラッシュ uFlash の 1→0 減衰時間（ms）。 */
export const FLASH_DECAY_MS = 220;

/** 全シーン共通の TSL uniforms 束。JS 側から毎フレーム値を流し込む。 */
export function createCommonUniforms() {
  return {
    time: uniform(0),    // speed 反映済みのシーン内時間（秒）
    burst: uniform(0),   // onset エンベロープ 0..1
    level: uniform(0),
    low: uniform(0),
    mid: uniform(0),
    high: uniform(0),
    dissolve: uniform(0), // 溶解 0..1
    flash: uniform(0),    // フラッシュ 1→0
    colorA: uniform(new THREE.Color(0.25, 0.45, 0.95)),
    colorB: uniform(new THREE.Color(0.85, 0.35, 0.65)),
    spectrum: uniformArray(new Array<number>(SPECTRUM_BINS).fill(0), "float"),
  };
}
export type CommonUniforms = ReturnType<typeof createCommonUniforms>;

/** VisualParams を共通 uniforms に反映（time は speed 込みで積算、flash は減衰）。 */
export function applyVisualParams(u: CommonUniforms, vp: VisualParams, dtMs: number): void {
  u.time.value += (dtMs / 1000) * vp.speed;
  u.burst.value = vp.burst;
  u.level.value = vp.level;
  u.low.value = vp.bands.low;
  u.mid.value = vp.bands.mid;
  u.high.value = vp.bands.high;
  u.flash.value = Math.max(0, u.flash.value - dtMs / FLASH_DECAY_MS);
  u.colorA.value.setRGB(vp.colorA.r, vp.colorA.g, vp.colorA.b);
  u.colorB.value.setRGB(vp.colorB.r, vp.colorB.g, vp.colorB.b);
  const arr = u.spectrum.array as number[];
  for (let i = 0; i < SPECTRUM_BINS; i++) arr[i] = vp.spectrum[i] ?? 0;
}

/** 加算合成のスプライト用マテリアル既定値。 */
export function createAdditiveSpriteMaterial(): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.AdditiveBlending;
  return m;
}

/** WebGPU インスタンシングで count 個描画する Sprite（WebGPU では Points が 1px 固定のため）。 */
export function createParticleSprite(material: THREE.SpriteNodeMaterial, count: number): THREE.Sprite {
  const sprite = new THREE.Sprite(material);
  sprite.count = count;
  sprite.frustumCulled = false;
  return sprite;
}
```

- [x] **Step 4: 検証**

Run: `npm run check`
Expected: 0 errors（uniformArray の `.array` は `unknown[]` 型なので cast が必要な点に注意）

---

### Task 4: Vortex シーン

**Files:**
- Create: `src/lib/vj/scenes/vortex.ts`

**Interfaces:**
- Produces: `createVortexScene(): SceneImpl`（id="vortex"）、`VORTEX_COUNT`
- Consumes: sceneUtils / types / SPECTRUM_BINS

- [x] **Step 1: 実装**

```ts
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, cos, sin, floor, hash, mix, mx_noise_float,
  PI2, instanceIndex, int, uv, smoothstep, length,
} from "three/tsl";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";
import type { VisualParams } from "../visualMapping";
import type { SceneContext, SceneImpl } from "./types";
import {
  applyVisualParams, createAdditiveSpriteMaterial,
  createCommonUniforms, createParticleSprite,
} from "./sceneUtils";

/** 粒子数（live 調整ポイント）。 */
export const VORTEX_COUNT = 6000;

/** Vortex: noise flow field の渦。spectrum で半径脈動、onset で放射バースト、chaos で溶解。 */
export function createVortexScene(): SceneImpl {
  const u = createCommonUniforms();
  let ctx: SceneContext | null = null;
  let sprite: THREE.Sprite | null = null;
  let material: THREE.SpriteNodeMaterial | null = null;

  return {
    id: "vortex",
    init(c: SceneContext) {
      ctx = c;
      material = createAdditiveSpriteMaterial();
      const idx = float(instanceIndex);
      const h1 = hash(idx);
      const h2 = hash(idx.add(1000));
      const h3 = hash(idx.add(2000));
      const h4 = hash(idx.add(3000));
      // 粒子ごとの担当 bin。その bin 値で半径が脈動する
      const sBin = u.spectrum.element(int(floor(h4.mul(SPECTRUM_BINS))));
      const r0 = h1.mul(1.8).add(0.3);
      // 内側ほど速い回転（渦）
      const ang = h2.mul(PI2).add(u.time.mul(float(1.4).div(r0.add(0.4))));
      // flow field: 位置依存ノイズで半径/奥行きを乱す
      const nz = mx_noise_float(vec3(cos(ang).mul(r0), sin(ang).mul(r0), u.time.mul(0.15)), 0.5);
      const rBurst = u.burst.mul(h2.mul(0.5).add(0.35)); // onset の放射押し出し
      const r = r0.add(sBin.mul(0.55)).add(nz.mul(0.3)).add(rBurst);
      const z = h3.sub(0.5).mul(1.1).add(nz.mul(0.35));
      // 溶解: 粒子ごとのランダム方向へ飛散
      const scatter = vec3(
        hash(idx.add(4000)).sub(0.5),
        hash(idx.add(5000)).sub(0.5),
        hash(idx.add(6000)).sub(0.5),
      ).mul(u.dissolve.mul(3.5));
      material.positionNode = vec3(cos(ang).mul(r), sin(ang).mul(r), z).add(scatter);
      const glow = u.level.mul(0.7).add(0.25).add(u.burst.mul(0.9)).add(sBin.mul(0.6));
      material.colorNode = mix(u.colorA, u.colorB, h2.mul(0.6).add(sBin.mul(0.4)))
        .mul(glow)
        .add(vec3(u.flash.mul(1.5)));
      // 丸くソフトな粒子（uv 距離でマスク）＋溶解で減光
      const soft = smoothstep(0.12, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
      material.opacityNode = soft.mul(0.85).mul(u.dissolve.mul(0.55).oneMinus());
      material.scaleNode = float(0.014)
        .add(u.level.mul(0.012))
        .add(u.burst.mul(0.02))
        .mul(h3.mul(0.9).add(0.55));
      sprite = createParticleSprite(material, VORTEX_COUNT);
      c.root.add(sprite);
    },
    update(vp: VisualParams, dtMs: number) {
      applyVisualParams(u, vp, dtMs);
      if (ctx) {
        ctx.camera.position.set(0, 0, 3.4);
        ctx.camera.lookAt(0, 0, 0);
      }
    },
    setDissolve(amount: number) {
      u.dissolve.value = amount;
    },
    flash() {
      u.flash.value = 1;
    },
    dispose() {
      if (sprite && ctx) ctx.root.remove(sprite);
      material?.dispose();
      sprite = null;
      material = null;
      ctx = null;
    },
  };
}
```

- [x] **Step 2: 検証**

Run: `npm run check && npm run build`
Expected: 0 errors / build 成功

---

### Task 5: RadialSpectrum シーン

**Files:**
- Create: `src/lib/vj/scenes/radialSpectrum.ts`

**Interfaces:**
- Produces: `createRadialSpectrumScene(): SceneImpl`（id="radialSpectrum"）、`RADIAL_PER_BIN`
- 内部: `uRing`（衝撃波半径）/`uRingAmp`（強度）は JS 側 update で駆動（onset 立ち上がり検出）

- [x] **Step 1: 実装**

```ts
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, cos, sin, floor, hash, mix, mx_noise_float,
  PI2, instanceIndex, int, uv, smoothstep, length, mod, exp, abs, uniform,
} from "three/tsl";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";
import type { VisualParams } from "../visualMapping";
import type { SceneContext, SceneImpl } from "./types";
import {
  applyVisualParams, createAdditiveSpriteMaterial,
  createCommonUniforms, createParticleSprite,
} from "./sceneUtils";

/** 各 bin の粒子数（live 調整ポイント）。総数 = SPECTRUM_BINS * RADIAL_PER_BIN。 */
export const RADIAL_PER_BIN = 130;
/** onset 衝撃波を発火する burst 立ち上がりしきい値。 */
export const RADIAL_BURST_EDGE = 0.55;

/** RadialSpectrum: spectrum[48] を 48 セクタの同心リングへ。onset で拡大する衝撃波。 */
export function createRadialSpectrumScene(): SceneImpl {
  const u = createCommonUniforms();
  const uRing = uniform(0);    // 衝撃波リング半径
  const uRingAmp = uniform(0); // 衝撃波強度 1→0
  let ctx: SceneContext | null = null;
  let sprite: THREE.Sprite | null = null;
  let material: THREE.SpriteNodeMaterial | null = null;
  let ring = 0;
  let ringAmp = 0;
  let lastBurst = 0;

  return {
    id: "radialSpectrum",
    init(c: SceneContext) {
      ctx = c;
      material = createAdditiveSpriteMaterial();
      const idx = float(instanceIndex);
      const per = float(RADIAL_PER_BIN);
      const binF = floor(idx.div(per)); // 0..47
      const sBin = u.spectrum.element(int(binF));
      const j = mod(idx, per).div(per); // bin 内 0..1
      const h1 = hash(idx);
      const h2 = hash(idx.add(1000));
      const h3 = hash(idx.add(2000));
      // セクタ角: bin を円周へ、bin 内でジッタ。全体はゆっくり回転
      const ang = binF.add(j.mul(0.92)).div(SPECTRUM_BINS).mul(PI2).add(u.time.mul(0.06));
      const wob = mx_noise_float(vec3(cos(ang), sin(ang), u.time.mul(0.25)), 0.05);
      // 半径: 基準リング + bin 値の脈動 + 揺らぎ
      const rr = float(0.45).add(h1.mul(0.1)).add(sBin.mul(1.4)).add(wob);
      // 衝撃波: リング半径との距離で発光・押し出し
      const ringGlow = exp(abs(rr.sub(uRing)).mul(-10)).mul(uRingAmp);
      const r = rr.add(ringGlow.mul(0.15));
      const z = sBin.mul(0.4).add(h2.sub(0.5).mul(0.15));
      const scatter = vec3(
        hash(idx.add(3000)).sub(0.5),
        hash(idx.add(4000)).sub(0.5),
        hash(idx.add(5000)).sub(0.5),
      ).mul(u.dissolve.mul(3.2));
      material.positionNode = vec3(cos(ang).mul(r), sin(ang).mul(r), z).add(scatter);
      const glow = u.level.mul(0.5).add(0.3).add(sBin.mul(0.9)).add(ringGlow);
      material.colorNode = mix(u.colorA, u.colorB, binF.div(SPECTRUM_BINS))
        .mul(glow)
        .add(vec3(ringGlow.mul(0.6)))
        .add(vec3(u.flash.mul(1.5)));
      const soft = smoothstep(0.12, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
      material.opacityNode = soft.mul(0.85).mul(u.dissolve.mul(0.55).oneMinus());
      material.scaleNode = float(0.011)
        .add(sBin.mul(0.016))
        .add(u.burst.mul(0.012))
        .mul(h3.mul(0.8).add(0.6));
      sprite = createParticleSprite(material, SPECTRUM_BINS * RADIAL_PER_BIN);
      c.root.add(sprite);
    },
    update(vp: VisualParams, dtMs: number) {
      applyVisualParams(u, vp, dtMs);
      // onset 立ち上がりで衝撃波リングを発火（中心から拡大→減衰）
      if (vp.burst > RADIAL_BURST_EDGE && lastBurst <= RADIAL_BURST_EDGE) {
        ring = 0.35;
        ringAmp = 1;
      }
      lastBurst = vp.burst;
      ring += (dtMs / 1000) * vp.speed * 2.4;
      ringAmp = Math.max(0, ringAmp - dtMs / 500);
      uRing.value = ring;
      uRingAmp.value = ringAmp;
      if (ctx) {
        ctx.camera.position.set(0, 0, 3.2);
        ctx.camera.lookAt(0, 0, 0);
      }
    },
    setDissolve(amount: number) {
      u.dissolve.value = amount;
    },
    flash() {
      u.flash.value = 1;
    },
    dispose() {
      if (sprite && ctx) ctx.root.remove(sprite);
      material?.dispose();
      sprite = null;
      material = null;
      ctx = null;
    },
  };
}
```

- [x] **Step 2: 検証**

Run: `npm run check && npm run build`
Expected: 0 errors / build 成功

---

### Task 6: Terrain シーン

**Files:**
- Create: `src/lib/vj/scenes/terrain.ts`

**Interfaces:**
- Produces: `createTerrainScene(): SceneImpl`（id="terrain"）、`TERRAIN_GRID`
- 内部: `uRipplePhase`/`uRippleAmp` を JS 駆動（onset でリップル）、カメラは低速オービット

- [x] **Step 1: 実装**

```ts
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, sin, floor, hash, mix, mx_noise_float,
  instanceIndex, int, uv, smoothstep, length, mod, exp, clamp, saturate, uniform,
} from "three/tsl";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";
import type { VisualParams } from "../visualMapping";
import type { SceneContext, SceneImpl } from "./types";
import {
  applyVisualParams, createAdditiveSpriteMaterial,
  createCommonUniforms, createParticleSprite,
} from "./sceneUtils";

/** グリッド一辺の粒子数（live 調整ポイント）。総数 = GRID^2。 */
export const TERRAIN_GRID = 88;
/** onset リップルを発火する burst 立ち上がりしきい値。 */
export const TERRAIN_BURST_EDGE = 0.55;

/** Terrain: spectrum で変位する高さ場。中心=低域/外周=高域。onset で同心円リップル。 */
export function createTerrainScene(): SceneImpl {
  const u = createCommonUniforms();
  const uRipplePhase = uniform(0);
  const uRippleAmp = uniform(0);
  let ctx: SceneContext | null = null;
  let sprite: THREE.Sprite | null = null;
  let material: THREE.SpriteNodeMaterial | null = null;
  let phase = 0;
  let rippleAmp = 0;
  let lastBurst = 0;
  let camT = 0;

  return {
    id: "terrain",
    init(c: SceneContext) {
      ctx = c;
      material = createAdditiveSpriteMaterial();
      const idx = float(instanceIndex);
      const g = float(TERRAIN_GRID);
      const ix = mod(idx, g);
      const iz = floor(idx.div(g));
      const x = ix.div(g.sub(1)).sub(0.5).mul(4.4);
      const zc = iz.div(g.sub(1)).sub(0.5).mul(4.4);
      const dist = length(vec2(x, zc));
      // 中心からの距離で bin 割当て（中心=低域, 外周=高域）
      const sBin = u.spectrum.element(int(clamp(dist.div(3.2), 0, 0.999).mul(SPECTRUM_BINS)));
      const nH = mx_noise_float(vec3(x.mul(0.8), zc.mul(0.8), u.time.mul(0.1)), 0.4);
      // onset リップル: 中心から拡がる同心円波
      const ripple = sin(dist.mul(7.5).sub(uRipplePhase)).mul(uRippleAmp).mul(exp(dist.mul(-0.9)));
      const y = sBin.mul(0.85).add(nH).add(ripple.mul(0.5)).sub(0.45);
      const scatter = vec3(
        hash(idx.add(1000)).sub(0.5),
        hash(idx.add(2000)).sub(0.5),
        hash(idx.add(3000)).sub(0.5),
      ).mul(u.dissolve.mul(3));
      material.positionNode = vec3(x, y, zc).add(scatter);
      // 高さで色を混ぜる（谷=colorA, 峰=colorB）
      const hNorm = saturate(y.add(0.6).mul(0.8));
      const glow = u.level.mul(0.5).add(0.3).add(u.burst.mul(0.5));
      material.colorNode = mix(u.colorA, u.colorB, hNorm)
        .mul(glow)
        .add(vec3(u.flash.mul(1.5)));
      const soft = smoothstep(0.12, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
      material.opacityNode = soft.mul(0.8).mul(u.dissolve.mul(0.55).oneMinus());
      material.scaleNode = float(0.012).add(u.level.mul(0.008)).mul(hash(idx).mul(0.5).add(0.7));
      sprite = createParticleSprite(material, TERRAIN_GRID * TERRAIN_GRID);
      c.root.add(sprite);
    },
    update(vp: VisualParams, dtMs: number) {
      applyVisualParams(u, vp, dtMs);
      // カメラの低速ドリフト（オービット）
      camT += (dtMs / 1000) * 0.05 * vp.speed;
      if (ctx) {
        ctx.camera.position.set(
          Math.sin(camT) * 3.8,
          1.7 + Math.sin(camT * 0.7) * 0.35,
          Math.cos(camT) * 3.8,
        );
        ctx.camera.lookAt(0, -0.1, 0);
      }
      // onset リップル（位相は常時進行、強度は onset で発火→減衰）
      if (vp.burst > TERRAIN_BURST_EDGE && lastBurst <= TERRAIN_BURST_EDGE) rippleAmp = 1;
      lastBurst = vp.burst;
      phase += (dtMs / 1000) * 3.5 * vp.speed;
      rippleAmp = Math.max(0, rippleAmp - dtMs / 700);
      uRipplePhase.value = phase;
      uRippleAmp.value = rippleAmp;
    },
    setDissolve(amount: number) {
      u.dissolve.value = amount;
    },
    flash() {
      u.flash.value = 1;
    },
    dispose() {
      if (sprite && ctx) ctx.root.remove(sprite);
      material?.dispose();
      sprite = null;
      material = null;
      ctx = null;
    },
  };
}
```

- [x] **Step 2: 検証**

Run: `npm run check && npm run build`
Expected: 0 errors / build 成功

---

### Task 7: Swarm シーン

**Files:**
- Create: `src/lib/vj/scenes/swarm.ts`

**Interfaces:**
- Produces: `createSwarmScene(): SceneImpl`（id="swarm"）、`SWARM_COUNT`、`SWARM_ATTRACTORS`
- 内部: アトラクタ位置は `uniformArray(Vector3[], "vec3")` を JS 側 update でリサージュ駆動（boids 簡略）。粒子は担当アトラクタ周りをノイズ軌道で回る。low で塊の大きさ、high で移動速度を変調。onset で散開。

- [x] **Step 1: 実装**

```ts
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, hash, mix, mx_noise_vec3,
  instanceIndex, int, floor, uv, smoothstep, length, normalize, uniform, uniformArray,
} from "three/tsl";
import type { VisualParams } from "../visualMapping";
import type { SceneContext, SceneImpl } from "./types";
import {
  applyVisualParams, createAdditiveSpriteMaterial,
  createCommonUniforms, createParticleSprite,
} from "./sceneUtils";

/** 粒子数とアトラクタ数（live 調整ポイント）。 */
export const SWARM_COUNT = 5200;
export const SWARM_ATTRACTORS = 8;

const TAU = Math.PI * 2;
// アトラクタごとのリサージュ係数（決定的）
const ORBITS = Array.from({ length: SWARM_ATTRACTORS }, (_, i) => ({
  fx: 0.045 + 0.011 * i,
  fy: 0.038 + 0.009 * ((i * 3) % SWARM_ATTRACTORS),
  fz: 0.031 + 0.01 * ((i * 5) % SWARM_ATTRACTORS),
  px: i * 0.7,
  py: i * 1.3,
  pz: i * 2.1,
}));

/** Swarm: アトラクタ群れ（boids 簡略）。onset で散開、low=塊の大きさ、high=速度。 */
export function createSwarmScene(): SceneImpl {
  const u = createCommonUniforms();
  const uSpread = uniform(0.5); // 塊の大きさ（bands.low 連動）
  const uAttractors = uniformArray(
    Array.from({ length: SWARM_ATTRACTORS }, () => new THREE.Vector3()),
    "vec3",
  );
  let ctx: SceneContext | null = null;
  let sprite: THREE.Sprite | null = null;
  let material: THREE.SpriteNodeMaterial | null = null;
  let t = 0;
  let swayT = 0;

  return {
    id: "swarm",
    init(c: SceneContext) {
      ctx = c;
      material = createAdditiveSpriteMaterial();
      const idx = float(instanceIndex);
      const h1 = hash(idx);
      const h2 = hash(idx.add(1000));
      // 担当アトラクタ
      const attr = uAttractors.element(int(floor(h1.mul(SWARM_ATTRACTORS))));
      // アトラクタ周りのノイズ軌道（時間で流れる）
      const wob = mx_noise_vec3(
        vec3(hash(idx.add(2000)).mul(60), hash(idx.add(3000)).mul(60), u.time.mul(0.5)),
        1,
      );
      const orbit = wob.mul(uSpread.mul(h2.mul(0.75).add(0.25)));
      // onset で外向きに散開（溶解も同方向へ大きく）
      const dir = normalize(vec3(
        hash(idx.add(4000)).sub(0.5),
        hash(idx.add(5000)).sub(0.5),
        hash(idx.add(6000)).sub(0.5),
      ));
      const burstPush = dir.mul(u.burst.mul(h1.mul(0.8).add(0.5)).mul(1.7));
      const scatter = dir.mul(u.dissolve.mul(3.5));
      material.positionNode = attr.add(orbit).add(burstPush).add(scatter);
      const glow = u.level.mul(0.6).add(0.3).add(u.burst.mul(0.7));
      material.colorNode = mix(u.colorA, u.colorB, h2)
        .mul(glow)
        .add(vec3(u.flash.mul(1.5)));
      const soft = smoothstep(0.12, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
      material.opacityNode = soft.mul(0.85).mul(u.dissolve.mul(0.55).oneMinus());
      material.scaleNode = float(0.013).add(u.level.mul(0.01)).mul(h1.mul(0.7).add(0.5));
      sprite = createParticleSprite(material, SWARM_COUNT);
      c.root.add(sprite);
    },
    update(vp: VisualParams, dtMs: number) {
      applyVisualParams(u, vp, dtMs);
      // 群れの移動速度: 高域で機敏に
      t += (dtMs / 1000) * vp.speed * (0.6 + vp.bands.high * 1.2);
      const arr = uAttractors.array as THREE.Vector3[];
      for (let i = 0; i < SWARM_ATTRACTORS; i++) {
        const o = ORBITS[i];
        arr[i].set(
          Math.sin(t * TAU * o.fx + o.px) * 1.35,
          Math.sin(t * TAU * o.fy + o.py) * 0.75,
          Math.sin(t * TAU * o.fz + o.pz) * 0.9,
        );
      }
      // 塊の大きさ: 低域で膨らむ
      uSpread.value = 0.22 + 0.85 * vp.bands.low;
      swayT += dtMs / 1000;
      if (ctx) {
        ctx.camera.position.set(Math.sin(swayT * 0.35) * 0.3, 0, 3.6);
        ctx.camera.lookAt(0, 0, 0);
      }
    },
    setDissolve(amount: number) {
      u.dissolve.value = amount;
    },
    flash() {
      u.flash.value = 1;
    },
    dispose() {
      if (sprite && ctx) ctx.root.remove(sprite);
      material?.dispose();
      sprite = null;
      material = null;
      ctx = null;
    },
  };
}
```

- [x] **Step 2: 検証**

Run: `npm run check && npm run build`
Expected: 0 errors / build 成功

---

### Task 8: dataLayer（読めるデータ層）

**Files:**
- Create: `src/lib/vj/dataLayer.ts`
- Modify: `src/routes/vj/+page.svelte`（#tl/#ro と .tl/.ro スタイルを撤去）

**Interfaces:**
- Produces: `createDataLayer(overlay: HTMLElement): DataLayer`、`DataLayer { update(snap: VjSnapshot, nowMs: number, sceneId: string): void; dispose(): void; }`
- Consumes: `VjSnapshot`（store）。テキストは 250ms スロットル、波形 canvas は毎フレーム。

- [x] **Step 1: 実装**（`src/lib/vj/dataLayer.ts`）

```ts
import type { VjSnapshot } from "./store";

/** テキスト更新のスロットル間隔（ms）。 */
const TEXT_INTERVAL_MS = 250;

export interface DataLayer {
  update(snap: VjSnapshot, nowMs: number, sceneId: string): void;
  dispose(): void;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/** 読めるデータ層: prompt/bpm/session/rotation progress/波形リボンを控えめに重ねる。 */
export function createDataLayer(overlay: HTMLElement): DataLayer {
  const top = document.createElement("div");
  top.style.cssText =
    "position:absolute;top:16px;left:20px;right:20px;font:13px ui-monospace,monospace;" +
    "color:rgba(207,232,255,0.8);text-shadow:0 1px 4px #000;letter-spacing:0.03em;white-space:pre;";
  const progress = document.createElement("div");
  progress.style.cssText =
    "position:absolute;top:40px;left:20px;height:2px;width:0;background:rgba(240,200,116,0.9);";
  const bottom = document.createElement("div");
  bottom.style.cssText =
    "position:absolute;bottom:52px;left:20px;right:20px;font:12px ui-monospace,monospace;" +
    "color:rgba(207,232,255,0.55);text-shadow:0 1px 4px #000;white-space:pre;line-height:1.6;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:absolute;bottom:10px;left:20px;width:calc(100% - 40px);height:36px;opacity:0.5;";
  overlay.append(top, progress, bottom, canvas);
  const cx = canvas.getContext("2d");
  let lastTextAt = 0;

  return {
    update(snap, nowMs, sceneId) {
      // 波形リボン（毎フレーム・細い1本線）
      if (cx) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w > 0 && (canvas.width !== w || canvas.height !== h)) {
          canvas.width = w;
          canvas.height = h;
        }
        cx.clearRect(0, 0, canvas.width, canvas.height);
        const wf = snap.frame.audio.waveform;
        if (wf.length > 1 && canvas.width > 0) {
          cx.beginPath();
          for (let i = 0; i < wf.length; i++) {
            const x = (i / (wf.length - 1)) * canvas.width;
            const y = canvas.height / 2 - wf[i] * (canvas.height / 2 - 1);
            if (i === 0) cx.moveTo(x, y);
            else cx.lineTo(x, y);
          }
          cx.strokeStyle = "rgba(143,233,255,0.9)";
          cx.lineWidth = 1;
          cx.stroke();
        }
      }
      // ローテーション進捗バー（rotating 中のみ）
      const prog = snap.state.controlParams.transitionProgress;
      const rotating = snap.state.session.state === "rotating";
      if (rotating && typeof prog === "number") {
        const w = Math.max(0, overlay.clientWidth - 40);
        progress.style.width = `${Math.max(0, Math.min(1, prog)) * w}px`;
      } else {
        progress.style.width = "0";
      }
      // テキスト（スロットル）
      if (nowMs - lastTextAt < TEXT_INTERVAL_MS) return;
      lastTextAt = nowMs;
      const { session, music, prompts } = snap.state;
      const elapsed = session.startedAtMs != null ? Date.now() - session.startedAtMs : null;
      const toRotate = session.rotateAtMs != null ? session.rotateAtMs - Date.now() : null;
      top.textContent =
        `${session.state}  scene:${sceneId}` +
        (elapsed != null ? `  ${fmt(elapsed)} / ${fmt(session.durationCapMs)}` : "") +
        (toRotate != null && !rotating ? `  ·  rotate in ${fmt(toRotate)}` : "") +
        (rotating && typeof prog === "number"
          ? `  ·  transition ${(prog * 100).toFixed(0)}%`
          : "");
      const promptLine = prompts.length
        ? prompts.map((p) => `${p.text} · w${p.weight.toFixed(1)}`).join("   ")
        : "";
      bottom.textContent =
        (promptLine ? `${promptLine}\n` : "") +
        `bpm ${music.bpm.toFixed(0)} · dens ${music.density.toFixed(2)} · bright ${music.brightness.toFixed(2)}` +
        `   seq ${snap.lastSeq} · drops ${snap.drops}`;
    },
    dispose() {
      top.remove();
      progress.remove();
      bottom.remove();
      canvas.remove();
    },
  };
}
```

- [x] **Step 2: `src/routes/vj/+page.svelte` の overlay を空に**

```svelte
<div bind:this={overlay} class="overlay"></div>
```

（`#tl`/`#ro` の div と `.tl`/`.ro` スタイルブロックを削除。`.overlay` の font-family/color 指定は残してよい）

- [x] **Step 3: 検証**

Run: `npm run check`
Expected: 0 errors

---

### Task 9: scene.ts 配線＋プレースホルダ layers/ 撤去

**Files:**
- Rewrite: `src/lib/vj/scene.ts`
- Delete: `src/lib/vj/layers/backgroundPulse.ts` / `waveformRibbon.ts` / `controlFlashes.ts` / `timeline.ts` / `readouts.ts`

**Interfaces:**
- Consumes: Task 1-8 の全 API。`startScene(holder, overlay, store)` のシグネチャは不変（`src/routes/vj/+page.svelte` から呼ばれる）。
- scene_next イベント契約: `TelemetryEvent{ kind:"control", ctrl:"param", id:"scene_next" }` を検出して `manager.next()`。開始前に積まれた古いイベントは `Date.now()` 初期化の透かしで無視。

- [x] **Step 1: scene.ts を書き換え**

```ts
import * as THREE from "three/webgpu";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";
import { createRenderer } from "./renderer";
import type { VjStore } from "./store";
import {
  bandsToColor, chaosToDissolve, hslToRgb, motionSpeed, onsetEnvelope,
  secondaryColor, smoothSpectrum, type VisualParams,
} from "./visualMapping";
import { createSceneManager } from "./sceneManager";
import { createDataLayer } from "./dataLayer";
import { createVortexScene } from "./scenes/vortex";
import { createRadialSpectrumScene } from "./scenes/radialSpectrum";
import { createTerrainScene } from "./scenes/terrain";
import { createSwarmScene } from "./scenes/swarm";
import type { SceneImpl } from "./scenes/types";

/** VJ シーンを開始。dispose 関数を返す。描画不可時も throw しない。 */
export async function startScene(
  holder: HTMLElement,
  overlay: HTMLElement,
  store: VjStore,
): Promise<() => void> {
  const bundle = await createRenderer(holder);
  if (!bundle) {
    overlay.textContent = "WebGPU 初期化に失敗しました（描画停止）";
    return () => {};
  }
  const { renderer, scene, camera, resize, dispose } = bundle;

  // 4 シーンを生成し、各専有グループへ init（表示は visible で切替＝カット）
  const impls: SceneImpl[] = [
    createVortexScene(),
    createRadialSpectrumScene(),
    createTerrainScene(),
    createSwarmScene(),
  ];
  const groups = new Map<string, THREE.Group>();
  for (const impl of impls) {
    const g = new THREE.Group();
    g.visible = false;
    scene.add(g);
    impl.init({ root: g, camera });
    groups.set(impl.id, g);
  }
  const manager = createSceneManager(
    impls.map((s) => ({ id: s.id, scene: s })),
    { autoSwitchOnRotate: true },
  );
  const dataLayer = createDataLayer(overlay);

  // 視覚マッピングの状態（フレーム間で保持）
  let env = 0;
  let spec: number[] = new Array<number>(SPECTRUM_BINS).fill(0);
  let lastSceneEventT = Date.now(); // 開始前に積まれた scene_next は無視
  let lastT = performance.now();

  let raf = 0;
  let running = true;
  const onResize = () => resize(holder.clientWidth, holder.clientHeight);
  window.addEventListener("resize", onResize);

  const loop = () => {
    if (!running) return;
    const nowMs = performance.now();
    const dtMs = Math.min(100, Math.max(0, nowMs - lastT));
    lastT = nowMs;
    try {
      const snap = store.snapshot();
      // scene_next イベント（control 窓の MIDI/ボタン発）でシーン切替
      for (const e of snap.events) {
        if (
          e.kind === "control" &&
          e.ctrl === "param" &&
          e.id === "scene_next" &&
          e.tMs > lastSceneEventT
        ) {
          manager.next();
          lastSceneEventT = e.tMs;
        }
      }
      // frame + state → 視覚パラメータ（純粋関数）
      const { audio } = snap.frame;
      env = onsetEnvelope(env, audio.onset, dtMs);
      spec = smoothSpectrum(spec, audio.spectrum, dtMs);
      const hsl = bandsToColor(audio.bands);
      const vp: VisualParams = {
        burst: env,
        spectrum: spec,
        level: audio.level,
        bands: audio.bands,
        colorA: hslToRgb(hsl.h, hsl.s, hsl.l),
        colorB: secondaryColor(hsl),
        speed: motionSpeed(snap.state.music.bpm),
      };
      const dissolveTarget = chaosToDissolve(snap.state.controlParams.chaos ?? 0);
      manager.frame(vp, { sessionState: snap.state.session.state, dissolveTarget }, dtMs);
      for (const [id, g] of groups) g.visible = id === manager.current();
      dataLayer.update(snap, nowMs, manager.current());
      void renderer.renderAsync(scene, camera);
    } catch (e) {
      // ライブ堅牢性: ループ内例外を握りつぶして継続
      console.error("[vj] loop error:", e);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
    for (const impl of impls) impl.dispose();
    dataLayer.dispose();
    dispose();
  };
}
```

（旧 `Layer` インターフェース export は削除。使用箇所は layers/ のみ）

- [x] **Step 2: layers/ を削除**

Run: `rm -r src/lib/vj/layers`
（削除対象 5 ファイルはすべて M6 で置換済みのプレースホルダ。他からの import が無いことを `grep -rn "layers/" src/` で確認してから実行）

- [x] **Step 3: 検証**

Run: `npm test && npm run check && npm run build`
Expected: 全緑

---

### Task 10: MIDI `scene_next` アクション＋control UI

**Files:**
- Modify: `src/lib/midi/types.ts`
- Modify: `src/routes/+page.svelte`

**Interfaces:**
- Produces: `ActionTarget` に `"scene_next"` 追加（Learn UI は `ACTION_TARGETS` 反復で自動追加）。control 窓の `applyAction("scene_next")` と「シーン切替」ボタンは `transport.pushEvent({kind:"control", ctrl:"param", id:"scene_next", ...})` を発行（VJ 窓が受けて `manager.next()`）。

- [x] **Step 1: types.ts に scene_next**

```ts
export type ActionTarget =
  | "reset_context"
  | "play_toggle"
  | "mute_bass"
  | "mute_drums"
  | "rotate"
  | "scene_next";

export const ACTION_TARGETS: ActionTarget[] = [
  "reset_context",
  "play_toggle",
  "mute_bass",
  "mute_drums",
  "rotate",
  "scene_next",
];
```

- [x] **Step 2: +page.svelte に sceneNext() と分岐・ボタン**

```ts
// M6: VJ シーン切替（イベント経由で VJ 窓へ通知。音源不問・稼働不問で使える）
function sceneNext() {
  transport?.pushEvent({
    kind: "control",
    tMs: Date.now(),
    source: "ui",
    ctrl: "param",
    id: "scene_next",
    value: 1,
    label: "scene_next",
  });
}
```

`applyAction` に追加:

```ts
      case "scene_next":
        sceneNext();
        break;
```

最下部の常時表示 `.row`（開始/停止の行）にボタン追加:

```svelte
    <button onclick={sceneNext}>シーン切替</button>
```

- [x] **Step 3: 検証**

Run: `npm test && npm run check && npm run build`
Expected: 全緑

---

### Task 11: 全体検証＋HANDOFF 更新

- [x] **Step 1: 全検証を実行**

```bash
npm test                                              # 106 想定（73+33）
npm run check                                         # 0 errors
npm run build                                         # 成功
cargo test --manifest-path src-tauri/Cargo.toml --lib # 6
cargo clippy --manifest-path src-tauri/Cargo.toml --lib # clean
```

- [x] **Step 2: HANDOFF.md へ「M6 実装完了メモ（2026-07-24）」追記＋現在地/段階ビルドプラン更新**

他の完了メモと同粒度で: 設計/計画パス、実装ファイル一覧、テスト数、live 未確認項目、調整ポイント（粒子数・ONSET_DECAY_MS・DEFAULT_DISSOLVE_EASE_MS・FLASH_DECAY_MS・各シーン係数）。

## 実施記録（2026-07-24・インライン実行）

- 全タスク完了。計画からの逸脱は 2 点:
  1. **型対応**: `@types/three` 0.185.1 では `uniformArray(...).element()` の戻り（`UniformArrayElementNode`）が ShaderNodeObject でラップされず chainable でない → `uniformArray<"float">(...)` / `uniformArray<"vec3">(...)` と literal generic を明示し、element 結果を `float()` / `vec3()` でラップ（ランタイムでも正当な変換ノード。実挙動に影響なし）。
  2. **追加テスト**: `src/lib/vj/scenes/scenes.test.ts`（TSL グラフ構築の smoke テスト・GPU 不要）を追加。4 シーンの init/update/setDissolve/flash/dispose が throw しないこと、Sprite 配線と count を検証（+4 tests）。
- 検証結果: vitest **110**（73+37: visualMapping 22 / sceneManager 11 / scenes smoke 4）・svelte-check **0 errors**・`npm run build` 成功・cargo test **6**・clippy **clean**。

## Self-Review 記録

- **Spec coverage**: §2 4シーン=Task 4-7 / §3 visualMapping=Task 1・sceneManager=Task 2・scenes=Task 4-7・dataLayer=Task 8・scene.ts=Task 9 / §4 データフロー=Task 9 / §5 scene_next=Task 10 / §6 テスト計画=Task 1-2（純粋）+ build/check（TSL）/ §7 M6.0 スコープ内。トランジションスタイル選択（dissolve/cut）は「手動=カット/フラッシュ・rotate=溶解」の二系統実装で担保（スタイル切替 UI は M6.0 スコープ外、spec §5 の「用意」は autoSwitchOnRotate オプションと manual cut の共存で満たす）。
- **Placeholder scan**: なし（全ステップ実コード）。
- **Type consistency**: `ManagedScene.update(vp, dtMs)` / `SceneImpl.init(ctx)` / `VisualParams` / `createSceneManager(entries, opts)` の署名は全タスクで一致確認済み。
