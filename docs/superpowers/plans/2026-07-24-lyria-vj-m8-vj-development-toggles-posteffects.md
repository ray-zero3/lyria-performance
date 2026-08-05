# M8: VJ 展開（トグル可能オブジェクト＋ポストエフェクト）＋ Max/MSP 風 control 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 単一 PromptSpace シーンに表示/非表示できるオブジェクト 5 種とポストエフェクト 5 種を追加し、control 窓（Max/MSP **Presentation モード**風に全面リスタイル）から prompt_space carry で操作できるようにする。

> **§7 訂正（user 指示 2026-07-24）**: パッチャー/エディットモードの見た目は**不採用**。パッチコード・インレット/アウトレット端子・格子/ドット・オブジェクトボックス（枠＋端子）は出さない。フラットな presentation ボード（落ち着いたグレー背景＋bgcolor パネル＋整然としたウィジェット）にする。

**Architecture:** carry（`PromptSpaceState.vjObjects`/`vjEffects`）→ 既存 prompt_space チャネル（Rust 変更なし）→ VJ 側で easeAlpha 補間して TSL uniform / RenderPipeline uniform に反映。ポストエフェクトは `three/webgpu` の `RenderPipeline`（旧 PostProcessing、r183 で改名）＋ `three/tsl` の `pass()` を起点に、glitch/split/rgbShift/scanline を 1 パスの自作 TSL 合成、bloom は `three/addons` の既製 `BloomNode` で構築。

**Tech Stack:** three 0.185.1（`three/webgpu` / `three/tsl` / `three/addons/tsl/display/BloomNode.js`）、SvelteKit + Svelte 5 runes、Vitest、Tauri v2（変更なし）。

## Global Constraints

- three **0.185.1** 固定。実 export 確認済み（下記「確認済み export」）。推測 API 使用禁止。
- **git はコミットしない**（プロジェクト合意。plan の各タスクにコミットステップは無い）。
- **Rust 変更なし**（carry は既存 prompt_space チャネル）。
- ベースライン緑を割らない: vitest **172**（実測済み）・svelte-check **0 errors**・`npm run build` 成功・cargo test **6**・clippy clean。M8 後は vitest が新規分だけ増える。
- コメント/対話は日本語。immutability（共有状態は新オブジェクト返し。シーン内アニメ状態の in-place 補間は既存パターン踏襲で可）。
- 切替は easeAlpha で滑らか（突然の出現/消失なし）。エフェクト 0 = 完全透過。
- PostProcessing/描画は GPU 依存 → vitest はグラフ構築 smoke のみ、実描画は build ＋ user live 確認。
- 秘密情報は扱わない。

## 確認済み export（three 0.185.1、node_modules 実物で確認済み）

- `three/webgpu`: `RenderPipeline`（`constructor(renderer, outputNode)` / `render(): void` / `dispose()`）。`PostProcessing` は r183 で `RenderPipeline` に改名された deprecated wrapper（warnOnce を出す）→ **RenderPipeline を使う**。
- `RenderPipeline.renderAsync()` は r181 で deprecated（`renderer.init()` 済みなら `render()` を使う）。既存 `renderer.ts` は `await renderer.init()` 済み。
- `three/tsl`: `pass(scene, camera)`（PassNode。`getTextureNode()` / `setSize(w,h)`、毎フレーム drawing buffer サイズへ自動追従も確認）、`Fn/uv/uniform/hash/time/step/fract/floor/mix/smoothstep/abs/sin/cos/vec2/vec3/vec4/float`。
- `three/addons/tsl/display/BloomNode.js`: `export const bloom = (node, strength, radius, threshold)`。`strength.isNode ? strength : uniform(strength)` → **uniform ノードを直接渡せる**。`dispose()` あり。@types/three に型定義あり。
- `TextureNode.sample(uvNode)` は既製 RGBShiftNode 内部でも使用される公式手法。
- `RenderPipeline` コンストラクタは `renderer` 参照保持＋`renderer.toneMapping`/`renderer.outputColorSpace` 読み出しのみ → **スタブ renderer で GPU 無し構築 smoke が可能**（`render()` は呼ばない）。

## File Structure

- Modify: `src/lib/prompts/promptSpace.ts` … `VjObjects`/`VjEffects` 型・キー定数・default/clamp 更新・`setVjObject`/`setVjEffect`
- Modify: `src/lib/prompts/promptSpace.test.ts` … 新フィールドのテスト
- Modify: `src/lib/prompts/persistence.test.ts` … round-trip に新フィールド反映
- Create: `src/lib/vj/vjToggles.ts` … carry → 目標値の純粋マッピング（`objectTargets`/`effectTargets`）
- Create: `src/lib/vj/vjToggles.test.ts`
- Modify: `src/lib/vj/scenes/promptSpace.ts` … トグル・オブジェクト 5 種＋補間
- Modify: `src/lib/vj/scenes/scenes.test.ts` … トグル ON での smoke
- Create: `src/lib/vj/post.ts` … `createPostFx`（RenderPipeline ＋ TSL 合成）
- Create: `src/lib/vj/post.test.ts` … グラフ構築 smoke
- Modify: `src/lib/vj/scene.ts` … post 経由レンダ・vjEffects 反映・resize 伝播
- Modify: `src/lib/prompts/PadEditor.svelte` … 「VJ 展開」パネル＋ Max 風リスタイル
- Modify: `src/routes/+page.svelte` … Max/MSP パッチャー風リスタイル

---

### Task 1: carry 拡張（vjObjects / vjEffects）

**Files:**
- Modify: `src/lib/prompts/promptSpace.ts`
- Test: `src/lib/prompts/promptSpace.test.ts`, `src/lib/prompts/persistence.test.ts`

**Interfaces:**
- Produces: `VJ_OBJECT_KEYS`/`VJ_EFFECT_KEYS`（as const 配列）、`VjObjectKey`/`VjEffectKey`/`VjObjects`/`VjEffects` 型、`defaultVjObjects()`/`defaultVjEffects()`、`setVjObject(s, key, on)`/`setVjEffect(s, key, amount)`（immutable）。`PromptSpaceState` に `vjObjects?: VjObjects; vjEffects?: VjEffects` 追加。`clampPromptSpaceState` は常に全キー埋めで出力。

- [x] **Step 1: 失敗するテストを書く** — `promptSpace.test.ts` 末尾に追加:

```ts
import 直下の import 群に VJ_OBJECT_KEYS, VJ_EFFECT_KEYS, defaultVjObjects, defaultVjEffects, setVjObject, setVjEffect を追加

describe("M8 vjObjects / vjEffects", () => {
  it("defaultPromptSpaceState は全オブジェクト false・全エフェクト 0", () => {
    const s = defaultPromptSpaceState();
    for (const k of VJ_OBJECT_KEYS) expect(s.vjObjects?.[k]).toBe(false);
    for (const k of VJ_EFFECT_KEYS) expect(s.vjEffects?.[k]).toBe(0);
  });

  it("setVjObject は immutable に ON/OFF を設定（未指定 state にも安全）", () => {
    const s = defaultPromptSpaceState();
    const next = setVjObject(s, "nebula", true);
    expect(next.vjObjects?.nebula).toBe(true);
    expect(s.vjObjects?.nebula).toBe(false); // 元は不変
    expect(next).not.toBe(s);
    const legacy = { ...s, vjObjects: undefined }; // 旧保存データ相当
    expect(setVjObject(legacy, "scan", true).vjObjects?.scan).toBe(true);
  });

  it("setVjEffect は clamp01 で immutable に設定", () => {
    const s = defaultPromptSpaceState();
    expect(setVjEffect(s, "glitch", 1.5).vjEffects?.glitch).toBe(1);
    expect(setVjEffect(s, "bloom", -3).vjEffects?.bloom).toBe(0);
    expect(setVjEffect(s, "split", 0.4).vjEffects?.split).toBeCloseTo(0.4, 9);
    expect(s.vjEffects?.glitch).toBe(0); // 元は不変
  });

  it("clampPromptSpaceState は vjObjects/vjEffects を防御整形（bool 化・clamp01・未指定デフォルト）", () => {
    const dirty = {
      pins: [], cursor: { x: 0.5, y: 0.5 }, targets: [],
      vjObjects: { nebula: 1, horizon: true, junk: true },
      vjEffects: { glitch: 5, split: -1, rgbShift: "a", bloom: 0.5 },
    };
    const s = clampPromptSpaceState(dirty);
    expect(s.vjObjects).toEqual({ nebula: false, horizon: true, scan: false, corePulse: false, constellation: false });
    expect(s.vjEffects).toEqual({ glitch: 1, split: 0, rgbShift: 0, bloom: 0.5, scanline: 0 });
    const s2 = clampPromptSpaceState({ pins: [], cursor: {}, targets: [] });
    expect(s2.vjObjects).toEqual(defaultVjObjects());
    expect(s2.vjEffects).toEqual(defaultVjEffects());
  });
});
```

`persistence.test.ts` の round-trip 入力（既存 cameraEnergy/floorReactive と同様に全キー埋めで）:

```ts
    const state: PromptSpaceState = {
      pins: [{ id: "a", text: "pads", x: 0.3, y: 0.4, radius: 0.2 }],
      cursor: { x: 0.6, y: 0.7 },
      targets: [{ id: "t", name: "drop", x: 0.9, y: 0.1 }],
      cameraEnergy: 0.4,
      floorReactive: true,
      vjObjects: { nebula: true, horizon: false, scan: true, corePulse: false, constellation: true },
      vjEffects: { glitch: 0.3, split: 0, rgbShift: 0.8, bloom: 0.5, scanline: 1 },
    };
```

- [x] **Step 2: 失敗を確認** — `npm test -- src/lib/prompts` → 新テストが FAIL（`VJ_OBJECT_KEYS` 未 export）。

- [x] **Step 3: 実装** — `promptSpace.ts`。`PromptSpaceState` に追加:

```ts
  /** M8: VJ 表示オブジェクトの ON/OFF（省略時 全 false）。 */
  vjObjects?: VjObjects;
  /** M8: VJ ポストエフェクト強度 0..1（省略時 全 0）。 */
  vjEffects?: VjEffects;
```

型・定数（`PromptSpaceState` の直前に）:

```ts
/** M8: 表示/非表示できる VJ オブジェクトのキー。 */
export const VJ_OBJECT_KEYS = ["nebula", "horizon", "scan", "corePulse", "constellation"] as const;
export type VjObjectKey = (typeof VJ_OBJECT_KEYS)[number];
export type VjObjects = Partial<Record<VjObjectKey, boolean>>;

/** M8: ポストエフェクトのキー（各 0..1 強度）。 */
export const VJ_EFFECT_KEYS = ["glitch", "split", "rgbShift", "bloom", "scanline"] as const;
export type VjEffectKey = (typeof VJ_EFFECT_KEYS)[number];
export type VjEffects = Partial<Record<VjEffectKey, number>>;

/** 既定: 全オブジェクト非表示。 */
export function defaultVjObjects(): Record<VjObjectKey, boolean> {
  return { nebula: false, horizon: false, scan: false, corePulse: false, constellation: false };
}
/** 既定: 全エフェクト 0（透過）。 */
export function defaultVjEffects(): Record<VjEffectKey, number> {
  return { glitch: 0, split: 0, rgbShift: 0, bloom: 0, scanline: 0 };
}
```

`defaultPromptSpaceState()` の return に `vjObjects: defaultVjObjects(), vjEffects: defaultVjEffects(),` を追加。

clamp 用ヘルパ（`coerceNum01` の下）＋ `clampPromptSpaceState` の return に追加:

```ts
function clampVjObjects(v: unknown): Record<VjObjectKey, boolean> {
  const o = (v ?? {}) as Record<string, unknown>;
  const out = defaultVjObjects();
  for (const k of VJ_OBJECT_KEYS) out[k] = o[k] === true;
  return out;
}
function clampVjEffects(v: unknown): Record<VjEffectKey, number> {
  const o = (v ?? {}) as Record<string, unknown>;
  const out = defaultVjEffects();
  for (const k of VJ_EFFECT_KEYS) out[k] = coerceNum01(o[k]);
  return out;
}
// clampPromptSpaceState の return に:
    vjObjects: clampVjObjects(o.vjObjects),
    vjEffects: clampVjEffects(o.vjEffects),
```

immutable ヘルパ（`setFloorReactive` の下）:

```ts
/** VJ 表示オブジェクトの ON/OFF を設定した新状態を返す（未指定キーはデフォルトで埋める）。 */
export function setVjObject(s: PromptSpaceState, key: VjObjectKey, on: boolean): PromptSpaceState {
  return { ...s, vjObjects: { ...defaultVjObjects(), ...s.vjObjects, [key]: on } };
}
/** VJ ポストエフェクト強度（0..1 clamp）を設定した新状態を返す。 */
export function setVjEffect(s: PromptSpaceState, key: VjEffectKey, amount: number): PromptSpaceState {
  return { ...s, vjEffects: { ...defaultVjEffects(), ...s.vjEffects, [key]: clamp01(amount) } };
}
```

- [x] **Step 4: パスを確認** — `npm test -- src/lib/prompts` → 全緑（persistence round-trip 含む）。

### Task 2: 純粋マッピング vjToggles（carry → 目標値）

**Files:**
- Create: `src/lib/vj/vjToggles.ts`
- Test: `src/lib/vj/vjToggles.test.ts`

**Interfaces:**
- Consumes: Task 1 の `VJ_OBJECT_KEYS`/`VJ_EFFECT_KEYS`/`VjObjects`/`VjEffects`。
- Produces: `objectTargets(o: VjObjects | undefined): Record<VjObjectKey, number>`（true→1、他→0）、`effectTargets(e: VjEffects | undefined): Record<VjEffectKey, number>`（clamp01、不正→0）。

- [x] **Step 1: 失敗するテストを書く** — `vjToggles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { objectTargets, effectTargets } from "./vjToggles";

describe("objectTargets / effectTargets（carry → VJ 目標値の純粋マッピング）", () => {
  it("objectTargets: true→1、false/未指定→0", () => {
    expect(objectTargets({ nebula: true, scan: false })).toEqual({
      nebula: 1, horizon: 0, scan: 0, corePulse: 0, constellation: 0,
    });
    expect(objectTargets(undefined)).toEqual({
      nebula: 0, horizon: 0, scan: 0, corePulse: 0, constellation: 0,
    });
  });
  it("effectTargets: clamp01・未指定/不正→0", () => {
    expect(effectTargets({ glitch: 0.4, split: 7, bloom: -2 })).toEqual({
      glitch: 0.4, split: 1, rgbShift: 0, bloom: 0, scanline: 0,
    });
    expect(effectTargets(undefined)).toEqual({
      glitch: 0, split: 0, rgbShift: 0, bloom: 0, scanline: 0,
    });
    expect(effectTargets({ rgbShift: Number.NaN })).toEqual({
      glitch: 0, split: 0, rgbShift: 0, bloom: 0, scanline: 0,
    });
  });
});
```

- [x] **Step 2: 失敗を確認** — `npm test -- src/lib/vj/vjToggles` → FAIL（モジュール無し）。

- [x] **Step 3: 実装** — `vjToggles.ts`:

```ts
// M8: carry（vjObjects/vjEffects）→ VJ 側の目標値（0..1）への純粋マッピング。
// three / DOM 非依存（Vitest で完全にテスト可能）。補間（easeAlpha）は使用側で行う。
import { clamp01 } from "$lib/telemetry/contract";
import {
  VJ_EFFECT_KEYS,
  VJ_OBJECT_KEYS,
  type VjEffectKey,
  type VjEffects,
  type VjObjectKey,
  type VjObjects,
} from "$lib/prompts/promptSpace";

/** vjObjects → 各オブジェクトの表示目標（true→1、他→0）。 */
export function objectTargets(o: VjObjects | undefined): Record<VjObjectKey, number> {
  const out = {} as Record<VjObjectKey, number>;
  for (const k of VJ_OBJECT_KEYS) out[k] = o?.[k] === true ? 1 : 0;
  return out;
}

/** vjEffects → 各エフェクトの強度目標（clamp01、不正/未指定→0）。 */
export function effectTargets(e: VjEffects | undefined): Record<VjEffectKey, number> {
  const out = {} as Record<VjEffectKey, number>;
  for (const k of VJ_EFFECT_KEYS) {
    const v = e?.[k];
    out[k] = clamp01(typeof v === "number" ? v : NaN);
  }
  return out;
}
```

- [x] **Step 4: パスを確認** — `npm test -- src/lib/vj/vjToggles` → 緑。

### Task 3: トグル・オブジェクト 5 種（scenes/promptSpace.ts）

**Files:**
- Modify: `src/lib/vj/scenes/promptSpace.ts`
- Test: `src/lib/vj/scenes/scenes.test.ts`

**Interfaces:**
- Consumes: Task 1 の `VJ_OBJECT_KEYS`/`VjObjectKey`、Task 2 の `objectTargets`、既存 `easeAlpha`/`createAdditiveSpriteMaterial`/`createParticleSprite`/共通 uniforms `u`。
- Produces: `applyTargets` が `space.vjObjects` から目標を設定し、`animate()` が `uObj*` uniform（0..1）を easeAlpha 補間。全オブジェクトは init で常時構築、OFF→0 で不可視。

- [x] **Step 1: 失敗するテストを書く** — `scenes.test.ts` の `promptSpace scene (M7)` describe に追加（import に `setVjObject`, `VJ_OBJECT_KEYS` を `$lib/prompts/promptSpace` から追加）:

```ts
  it("M8: vjObjects 全 ON → 一部 OFF でも throw せず全撤去できる", () => {
    const scene = createPromptSpaceScene();
    const root = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 60);
    scene.init({ root, camera });
    let space = defaultPromptSpaceState();
    for (const k of VJ_OBJECT_KEYS) space = setVjObject(space, k, true);
    scene.setPromptSpace(space);
    for (let i = 0; i < 5; i++) scene.update(vp(), 16.7);
    scene.setPromptSpace(setVjObject(space, "nebula", false)); // OFF はフェードで消える
    scene.update(vp(), 16.7);
    scene.dispose();
    expect(root.children).toHaveLength(0);
  });
```

- [x] **Step 2: 失敗を確認** — `npm test -- src/lib/vj/scenes` → 現状は throw しないので**このテストは通ってしまう可能性が高い**（挙動追加のため）。通った場合は「実装後も緑を維持する回帰テスト」として扱い先へ進む（TDD の RED は Task 1/2 の純粋ロジックで担保済み）。

- [x] **Step 3: 実装** — `scenes/promptSpace.ts` に以下を追加。

import 追加: `pow` は不要（`.pow()` メソッド使用）。`objectTargets` と `VjObjectKey`/`VJ_OBJECT_KEYS`:

```ts
import { VJ_OBJECT_KEYS, type VjObjectKey, ... } from "$lib/prompts/promptSpace"; // 既存 import に追加
import { objectTargets } from "../vjToggles";
```

定数（FLOOR 定数の下）:

```ts
// M8: トグル・オブジェクト（表示強度 uniform を easeAlpha で補間。OFF→0 で不可視）
export const NEBULA_COUNT = 36; // 星雲: 少数・大サイズの霧スプライト
export const HORIZON_COUNT = 3200; // ワイヤードーム粒子（緯線リング）
export const SCAN_COUNT = 2600; // スキャン面の粒子
export const CORE_COUNT = 3; // 中央パルスの同心リング数
export const CONST_STARS = 14; // 星座線の擬似星ノード数
export const OBJ_TAU = 420; // トグル ON/OFF のフェード時定数（ms）
```

`createPromptSpaceScene()` 内、`uFloorReactive` の下に uniforms と状態:

```ts
  // M8: トグル・オブジェクトの表示強度（0..1、curObj を滑らかに反映）
  const uObjNebula = uniform(0);
  const uObjHorizon = uniform(0);
  const uObjScan = uniform(0);
  const uObjCore = uniform(0);
  // constellation は LineSegments（TSL 非対応）のため material.opacity を JS 側で更新
```

アニメ状態（`curFloor`/`tgtFloor` の下）:

```ts
  // M8: トグル・オブジェクトの current/target（applyTargets が目標、animate が補間）
  const curObj: Record<VjObjectKey, number> = { nebula: 0, horizon: 0, scan: 0, corePulse: 0, constellation: 0 };
  const tgtObj: Record<VjObjectKey, number> = { ...curObj };
  // M8 constellation: 決定的擬似星＋アクティブピンを結ぶ輝線
  let constGeo: THREE.BufferGeometry | null = null;
  let constMat: THREE.LineBasicMaterial | null = null;
  const constStars: THREE.Vector3[] = [];
  const CONST_SEGMENTS = CONST_STARS + MAX_VIS_PINS; // 星チェーン(CONST_STARS-1)+ピン→星(MAX_VIS_PINS)+カーソル→星(1)
```

build 関数 5 種（`buildGrid` の下に追加。既存 TSL 手法踏襲・加算 Sprite）:

```ts
  /** M8 nebula: 大きく柔らかい霧/星雲（少数・大サイズ、level で明滅）。 */
  const buildNebula = (): void => {
    const material = createAdditiveSpriteMaterial();
    const idx = float(instanceIndex);
    const h1 = hash(idx);
    const h2 = hash(idx.add(101));
    const h3 = hash(idx.add(202));
    const h4 = hash(idx.add(303));
    const ang = h1.mul(PI2).add(u.time.mul(0.03));
    const rad = float(1.2).add(h2.mul(4.5));
    const wob = mx_noise_float(vec3(h1.mul(10), h2.mul(10), u.time.mul(0.05)), 1);
    material.positionNode = vec3(
      cos(ang).mul(rad),
      h3.mul(2.2).add(0.2).add(wob.mul(0.4)),
      sin(ang).mul(rad),
    );
    const breathe = sin(u.time.mul(h4.mul(0.4).add(0.1)).add(h1.mul(PI2))).mul(0.5).add(0.5);
    material.colorNode = mix(vec3(0.1, 0.22, 0.38), vec3(0.3, 0.12, 0.42), h2)
      .mul(float(0.5).add(breathe.mul(0.5)).add(u.level.mul(0.9)))
      .add(vec3(u.flash.mul(0.4)));
    const soft = smoothstep(0.5, 0.05, length(uv().sub(vec2(0.5))));
    material.opacityNode = soft
      .mul(uObjNebula)
      .mul(float(0.1).add(breathe.mul(0.08)))
      .mul(u.dissolve.oneMinus());
    material.scaleNode = float(1.6).add(h3.mul(2.6)).add(u.level.mul(0.5));
    addObject(createParticleSprite(material, NEBULA_COUNT), material);
  };

  /** M8 horizon: 地平線リング＋ワイヤードーム（緯線リング状の粒子、空間の広がり）。 */
  const buildHorizon = (): void => {
    const material = createAdditiveSpriteMaterial();
    const idx = float(instanceIndex);
    const h1 = hash(idx);
    const h2 = hash(idx.add(77));
    const RINGS = 5;
    const ring = floor(h1.mul(RINGS)); // 0..4 の緯線リング（0=地平線）
    const lat = ring.div(RINGS).mul(0.45 * Math.PI);
    const R = float(7.5);
    const az = h2.mul(PI2).add(u.time.mul(0.04).mul(ring.mul(0.3).add(0.4)));
    material.positionNode = vec3(
      cos(lat).mul(cos(az)).mul(R),
      sin(lat).mul(R).mul(0.55),
      cos(lat).mul(sin(az)).mul(R),
    );
    const tw = sin(u.time.mul(1.2).add(h1.mul(PI2))).mul(0.5).add(0.5);
    material.colorNode = mix(CYAN, vec3(0.5, 0.65, 1), h1)
      .mul(float(0.5).add(tw.mul(0.4)).add(u.mid.mul(0.6)))
      .add(vec3(u.flash.mul(0.7)));
    const soft = smoothstep(0.14, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
    material.opacityNode = soft
      .mul(uObjHorizon)
      .mul(float(0.35).add(tw.mul(0.3)))
      .mul(u.dissolve.mul(0.6).oneMinus());
    material.scaleNode = float(0.015).add(h2.mul(0.012)).add(u.burst.mul(0.008));
    addObject(createParticleSprite(material, HORIZON_COUNT), material);
  };

  /** M8 scan: 上下に走る水平スキャン面（time で往復、onset で増光）。 */
  const buildScan = (): void => {
    const material = createAdditiveSpriteMaterial();
    const idx = float(instanceIndex);
    const h1 = hash(idx);
    const h2 = hash(idx.add(55));
    const h3 = hash(idx.add(99));
    const rr = h1.pow(0.5).mul(PAD_SCALE * 0.85); // 円盤上に面積一様分布
    const az = h2.mul(PI2);
    const ph = fract(u.time.mul(0.16).add(u.burst.mul(0.05))); // onset で位相が進む
    const trig = abs(ph.mul(2).sub(1)).oneMinus(); // 0→1→0 の三角波（往復）
    const y = trig.mul(2.4);
    material.positionNode = vec3(cos(az).mul(rr), y.add(h3.mul(0.05)), sin(az).mul(rr));
    material.colorNode = GREEN.mul(float(0.8).add(u.burst.mul(1.6))).add(vec3(u.flash));
    const soft = smoothstep(0.12, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
    material.opacityNode = soft
      .mul(uObjScan)
      .mul(float(0.1).add(u.burst.mul(0.25)))
      .mul(u.dissolve.mul(0.7).oneMinus());
    material.scaleNode = float(0.012).add(h3.mul(0.01));
    addObject(createParticleSprite(material, SCAN_COUNT), material);
  };

  /** M8 corePulse: 中央の大きなビートパルス（burst/level で拡大・発光する同心リング）。 */
  const buildCorePulse = (): void => {
    const material = createAdditiveSpriteMaterial();
    const k = float(instanceIndex);
    const phase = fract(u.time.mul(0.5).add(k.div(CORE_COUNT)));
    material.positionNode = vec3(0, 0.6, 0);
    const d = length(uv().sub(vec2(0.5)));
    const ringR = mix(float(0.06), float(0.46), phase);
    const ring = smoothstep(0.045, 0.0, abs(d.sub(ringR)));
    const glow = smoothstep(0.2, 0.0, d).mul(0.35);
    material.colorNode = mix(vec3(1, 1, 1), CYAN, phase)
      .mul(float(0.8).add(u.burst.mul(2.2)).add(u.level.mul(0.8)))
      .add(vec3(u.flash));
    material.opacityNode = ring
      .add(glow)
      .mul(uObjCore)
      .mul(phase.oneMinus().mul(0.8).add(0.2))
      .mul(u.dissolve.oneMinus());
    material.scaleNode = float(0.7).add(u.level.mul(0.5)).add(u.burst.mul(0.9)).add(phase.mul(0.6));
    addObject(createParticleSprite(material, CORE_COUNT), material);
  };

  /** M8 constellation: 決定的擬似星＋アクティブピン/カーソルを結ぶ星座線（動的更新は animate）。 */
  const buildConstellation = (): void => {
    for (let i = 0; i < CONST_STARS; i++) {
      const a = (i * 2.399963) % (Math.PI * 2); // 黄金角で決定的に散らす
      const r = 1.2 + ((i * 0.83) % 1) * 2.2;
      constStars.push(
        new THREE.Vector3(Math.cos(a) * r, 1.0 + ((i * 0.37) % 1) * 1.6, Math.sin(a) * r),
      );
    }
    constGeo = new THREE.BufferGeometry();
    constGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(CONST_SEGMENTS * 2 * 3), 3),
    );
    constMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(0.55, 0.9, 1),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(constGeo, constMat);
    lines.frustumCulled = false;
    addObject(lines, constGeo, constMat);
  };
```

`applyTargets` に（4) カメラ激しさ / 床反応の目標 の下）:

```ts
    // 4b) M8: トグル・オブジェクトの表示目標（true→1 / false→0）
    Object.assign(tgtObj, objectTargets(space?.vjObjects));
```

`animate` 末尾（カメラ激しさ・床反応 の下）に:

```ts
    // M8: トグル・オブジェクトの表示強度（ON/OFF を滑らかに）
    const oA = easeAlpha(dtMs, OBJ_TAU);
    for (const k of VJ_OBJECT_KEYS) curObj[k] += (tgtObj[k] - curObj[k]) * oA;
    uObjNebula.value = curObj.nebula;
    uObjHorizon.value = curObj.horizon;
    uObjScan.value = curObj.scan;
    uObjCore.value = curObj.corePulse;

    // M8 constellation: 線の張り替え（擬似星チェーン＋アクティブピン→最寄り星＋カーソル→最寄り星）
    if (constGeo && constMat) {
      constMat.opacity = curObj.constellation * 0.4;
      if (curObj.constellation > 0.005) {
        const pAttr = constGeo.getAttribute("position") as THREE.BufferAttribute;
        let seg = 0;
        const nearestStar = (p: { x: number; y: number; z: number }): THREE.Vector3 => {
          let best = constStars[0];
          let bd = Infinity;
          for (const s of constStars) {
            const d = (s.x - p.x) ** 2 + (s.y - p.y) ** 2 + (s.z - p.z) ** 2;
            if (d < bd) { bd = d; best = s; }
          }
          return best;
        };
        for (let i = 0; i < CONST_STARS - 1; i++, seg++) {
          const a = constStars[i];
          const b = constStars[i + 1];
          pAttr.setXYZ(seg * 2, a.x, a.y, a.z);
          pAttr.setXYZ(seg * 2 + 1, b.x, b.y, b.z);
        }
        for (let s = 0; s < MAX_VIS_PINS; s++, seg++) {
          if (aArr[s] > 0.05) {
            const near = nearestStar(posArr[s]);
            pAttr.setXYZ(seg * 2, posArr[s].x, posArr[s].y, posArr[s].z);
            pAttr.setXYZ(seg * 2 + 1, near.x, near.y, near.z);
          } else {
            pAttr.setXYZ(seg * 2, 0, -10, 0);
            pAttr.setXYZ(seg * 2 + 1, 0, -10, 0);
          }
        }
        const nc = nearestStar(cur);
        pAttr.setXYZ(seg * 2, cur.x, cur.y, cur.z);
        pAttr.setXYZ(seg * 2 + 1, nc.x, nc.y, nc.z);
        pAttr.needsUpdate = true;
      }
    }
```

`init` に build 追加（`buildReactiveFloor()` の下）:

```ts
      // M8: トグル・オブジェクト（常時構築、uObj*=0 で不可視）
      buildNebula();
      buildHorizon();
      buildScan();
      buildCorePulse();
      buildConstellation();
```

`dispose` に `constGeo = null; constMat = null; constStars.length = 0;` を追加（`lineGeo = null;` の下）。

- [x] **Step 4: パスを確認** — `npm test -- src/lib/vj/scenes` → 緑（既存 smoke ＋ 新テスト）。

### Task 4: ポストエフェクト post.ts ＋ scene.ts 配線

**Files:**
- Create: `src/lib/vj/post.ts`
- Test: `src/lib/vj/post.test.ts`
- Modify: `src/lib/vj/scene.ts`

**Interfaces:**
- Consumes: Task 1 の `VJ_EFFECT_KEYS`/`VjEffectKey`、Task 2 の `effectTargets`、既存 `easeAlpha`。
- Produces: `createPostFx(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): PostFx`、`PostFx = { setEffect(name: VjEffectKey, amount: number): void; renderAsync(): Promise<void>; setSize(w: number, h: number): void; dispose(): void }`。

- [x] **Step 1: 失敗するテストを書く** — `post.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as THREE from "three/webgpu";
import { createPostFx, FX_TAU } from "./post";
import { VJ_EFFECT_KEYS } from "$lib/prompts/promptSpace";

// GPU 無しでの TSL グラフ構築 smoke。RenderPipeline のコンストラクタは
// renderer 参照の保持（toneMapping/outputColorSpace 読み出し）のみなので
// スタブで構築できる。render() は GPU 依存のため呼ばない（live 確認に委ねる）。
function fakeRenderer(): THREE.WebGPURenderer {
  return {
    toneMapping: THREE.NoToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
  } as unknown as THREE.WebGPURenderer;
}

describe("createPostFx（TSL グラフ構築 smoke）", () => {
  it("構築・setEffect（clamp 含む）・setSize・dispose が throw しない", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 60);
    const post = createPostFx(fakeRenderer(), scene, camera);
    for (const k of VJ_EFFECT_KEYS) post.setEffect(k, 0.7);
    post.setEffect("glitch", 99); // 範囲外もクランプで安全
    post.setEffect("bloom", Number.NaN);
    post.setSize(1280, 720);
    post.dispose();
    expect(FX_TAU).toBeGreaterThan(0);
  });
});
```

- [x] **Step 2: 失敗を確認** — `npm test -- src/lib/vj/post` → FAIL（モジュール無し）。

- [x] **Step 3: post.ts を実装**:

```ts
// M8: ポストエフェクトチェーン（three/webgpu RenderPipeline ＋ TSL）。
// glitch/split/rgbShift/scanline は 1 パスの自作 TSL 合成（uniform 0..1、0=完全透過）、
// bloom は three/addons の既製 BloomNode（strength に uniform ノードを直結）。
//
// 【確認済み export（three 0.185.1 実物）】
// - three/webgpu: RenderPipeline（旧 PostProcessing。r183 で改名、旧名は deprecated wrapper）
// - RenderPipeline.renderAsync() は r181 で deprecated → renderer.init() 済み前提で render() を使用
// - three/tsl: pass / Fn / uv / uniform / hash / time / step / fract / floor / mix /
//   smoothstep / abs / sin / cos / vec2 / vec3 / vec4 / float
// - three/addons/tsl/display/BloomNode.js: bloom(node, strength, radius, threshold)
// - pass() の RenderTarget は毎フレーム drawing buffer サイズへ自動追従（setSize は即時反映用）
import * as THREE from "three/webgpu";
import {
  Fn, abs, cos, float, floor, fract, hash, mix, pass, sin, smoothstep, step,
  time, uniform, uv, vec2, vec3, vec4,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { VJ_EFFECT_KEYS, type VjEffectKey } from "$lib/prompts/promptSpace";
import { easeAlpha } from "./cameraRig";

/** エフェクト強度の平滑時定数（ms）（live 調整ポイント）。 */
export const FX_TAU = 260;
/** amount=1 のときの BloomNode strength（live 調整ポイント）。 */
export const BLOOM_MAX_STRENGTH = 1.35;

export interface PostFx {
  /** carry(vjEffects) からの目標強度（0..1、clamp）。内部で easeAlpha 平滑。 */
  setEffect(name: VjEffectKey, amount: number): void;
  /** ポストエフェクト込みで 1 フレーム描画。 */
  renderAsync(): Promise<void>;
  /** リサイズ伝播（自動追従もあるが即時反映のため呼ぶ）。 */
  setSize(w: number, h: number): void;
  dispose(): void;
}

/** PostFx を構築。TSL グラフ構築のみで GPU は要求しない（実描画は renderAsync 時）。 */
export function createPostFx(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostFx {
  // 目標/現在値（renderAsync 毎に easeAlpha で追従 → uniform へ）
  const tgt: Record<VjEffectKey, number> = { glitch: 0, split: 0, rgbShift: 0, bloom: 0, scanline: 0 };
  const cur: Record<VjEffectKey, number> = { ...tgt };
  const uGlitch = uniform(0);
  const uSplit = uniform(0);
  const uRgb = uniform(0);
  const uScan = uniform(0);
  const uBloomStrength = uniform(0);

  const scenePass = pass(scene, camera);
  const sceneTex = scenePass.getTextureNode();

  // 自作合成: split（ミラータイル）→ scanline 微歪み → glitch（行ずらし）→ rgbShift サンプル → 走査線減光
  const composed = Fn(() => {
    const u0 = uv();
    // split: ミラー折返しタイル（amount→タイル数 1..4）。mix で 0=元 UV（完全透過）
    const tiles = float(1).add(uSplit.mul(3));
    const mirrored = abs(fract(u0.mul(tiles).mul(0.5)).mul(2).sub(1));
    const uvS = mix(u0, mirrored, smoothstep(0.01, 0.25, uSplit));
    // scanline のわずかな水平歪み
    const wobble = sin(uvS.y.mul(90).add(time.mul(3))).mul(uScan.mul(0.0025));
    // glitch: 行ブロックの水平ずらし（~8Hz で更新、強度で行数/対象行/量が増える）
    const rows = floor(uvS.y.mul(mix(float(10), float(36), uGlitch)));
    const seed = floor(time.mul(8));
    const r1 = hash(rows.add(seed.mul(131)));
    const r2 = hash(rows.add(seed.mul(113)).add(51));
    const gate = step(float(1).sub(uGlitch.mul(0.92)), r1);
    const shift = r2.sub(0.5).mul(0.5).mul(uGlitch).mul(gate);
    const uvG = vec2(fract(uvS.x.add(shift).add(wobble)), uvS.y);
    // rgbShift: 色収差（方向は緩く回転、glitch 行では追加分離）。0 でオフセット 0 = 透過
    const ang = time.mul(0.6);
    const off = vec2(cos(ang), sin(ang)).mul(uRgb.mul(0.012)).add(vec2(shift.mul(0.35), 0));
    const cr = sceneTex.sample(uvG.add(off));
    const cg = sceneTex.sample(uvG);
    const cb = sceneTex.sample(uvG.sub(off));
    const col = vec3(cr.r, cg.g, cb.b).toVar();
    // scanline: 走査線の減光
    const scan = sin(uvG.y.mul(640).add(time.mul(6))).mul(0.5).add(0.5);
    col.mulAssign(float(1).sub(uScan.mul(0.4).mul(scan)));
    return vec4(col, 1);
  })();

  // bloom は合成結果へ加算（strength=0 で寄与ゼロ＝透過）
  const bloomNode = bloom(composed, uBloomStrength, 0.4, 0.55);
  const pipeline = new THREE.RenderPipeline(renderer, composed.add(bloomNode));

  let lastT = typeof performance !== "undefined" ? performance.now() : 0;

  return {
    setEffect(name: VjEffectKey, amount: number): void {
      if (!VJ_EFFECT_KEYS.includes(name)) return;
      tgt[name] = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
    },
    async renderAsync(): Promise<void> {
      const now = performance.now();
      const dt = Math.min(100, Math.max(0, now - lastT));
      lastT = now;
      const a = easeAlpha(dt, FX_TAU);
      for (const k of VJ_EFFECT_KEYS) cur[k] += (tgt[k] - cur[k]) * a;
      uGlitch.value = cur.glitch;
      uSplit.value = cur.split;
      uRgb.value = cur.rgbShift;
      uScan.value = cur.scanline;
      uBloomStrength.value = cur.bloom * BLOOM_MAX_STRENGTH;
      pipeline.render();
    },
    setSize(w: number, h: number): void {
      scenePass.setSize(w, h);
    },
    dispose(): void {
      pipeline.dispose();
      bloomNode.dispose();
      scenePass.dispose();
    },
  };
}
```

- [x] **Step 4: パスを確認** — `npm test -- src/lib/vj/post` → 緑。

- [x] **Step 5: scene.ts 配線** — import 追加:

```ts
import { VJ_EFFECT_KEYS, type PromptSpaceState } from "$lib/prompts/promptSpace";
import { effectTargets } from "./vjToggles";
import { createPostFx, type PostFx } from "./post";
```

`const { renderer, scene, camera, resize, dispose } = bundle;` の直後:

```ts
  // M8: ポストエフェクト（構築失敗時は素のレンダにフォールバックして継続）
  let post: PostFx | null = null;
  try {
    post = createPostFx(renderer, scene, camera);
  } catch (e) {
    console.error("[vj] PostFx 構築失敗（素のレンダで継続）:", e);
  }
```

`onResize` を post 伝播ありに変更:

```ts
  const onResize = () => {
    resize(holder.clientWidth, holder.clientHeight);
    post?.setSize(holder.clientWidth, holder.clientHeight);
  };
```

ループ内、`promptSpace.setPromptSpace(snap.promptSpace);` の直後（参照キャッシュで安価に）:

```ts
      // M8: carry(vjEffects) → PostFx 目標強度（同一参照はスキップ）
      if (post && snap.promptSpace !== lastFxSpace) {
        lastFxSpace = snap.promptSpace;
        const fxT = effectTargets(snap.promptSpace?.vjEffects);
        for (const k of VJ_EFFECT_KEYS) post.setEffect(k, fxT[k]);
      }
```

状態変数（`let lastT = performance.now();` の下）:

```ts
  let lastFxSpace: PromptSpaceState | null | undefined; // undefined = 未注入
```

レンダ行を差し替え:

```ts
      if (post) void post.renderAsync();
      else void renderer.renderAsync(scene, camera);
```

dispose クロージャに `post?.dispose();`（`dispose();` の直前）を追加。

- [x] **Step 6: 全体テスト＋ build** — `npm test` 全緑・`npm run build` 成功（three/addons import が bundle に通ること）。

### Task 5: control UI「VJ 展開」パネル（PadEditor）

**Files:**
- Modify: `src/lib/prompts/PadEditor.svelte`

**Interfaces:**
- Consumes: Task 1 の `VJ_OBJECT_KEYS`/`VJ_EFFECT_KEYS`/`setVjObject`/`setVjEffect`、既存 `commit()`/`snap()`（変更→localStorage＋onSpace 送信）。

- [x] **Step 1: script に import とラベルを追加**:

```ts
  // 既存 import 群に追加
  setVjEffect,
  setVjObject,
  VJ_EFFECT_KEYS,
  VJ_OBJECT_KEYS,
  type VjEffectKey,
  type VjObjectKey,
```

```ts
  // M8: VJ 展開パネルの表示ラベル
  const VJ_OBJECT_LABELS: Record<VjObjectKey, string> = {
    nebula: "星雲",
    horizon: "地平線ドーム",
    scan: "スキャン",
    corePulse: "中央パルス",
    constellation: "星座線",
  };
  const VJ_EFFECT_LABELS: Record<VjEffectKey, string> = {
    glitch: "glitch",
    split: "split",
    rgbShift: "rgbShift",
    bloom: "bloom",
    scanline: "scanline",
  };
```

- [x] **Step 2: `.view` div の直後に「VJ 展開」パネルを追加**（既存 commit/onSpace 経路をそのまま使用）:

```svelte
    <div class="vjdev">
      <div class="boxtitle">VJ 展開</div>
      <div class="row wrap">
        {#each VJ_OBJECT_KEYS as k (k)}
          <label class="check">
            <input
              type="checkbox"
              checked={space.vjObjects?.[k] ?? false}
              onchange={(e) => commit(setVjObject(snap(), k, e.currentTarget.checked))}
            />
            {VJ_OBJECT_LABELS[k]}
          </label>
        {/each}
      </div>
      {#each VJ_EFFECT_KEYS as k (k)}
        <label>
          <span class="fxname">{VJ_EFFECT_LABELS[k]}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={space.vjEffects?.[k] ?? 0}
            oninput={(e) => commit(setVjEffect(snap(), k, Number(e.currentTarget.value)))}
          />
          {(space.vjEffects?.[k] ?? 0).toFixed(2)}
        </label>
      {/each}
    </div>
```

（`.vjdev` / `.boxtitle` / `.fxname` のスタイルは Task 6 の Max 風リスタイルでまとめて定義する。）

- [x] **Step 3: 検証** — `npm run check` 0 errors。

### Task 6: §7 Max/MSP **Presentation モード**風リスタイル（+page.svelte / PadEditor.svelte）

**Files:**
- Modify: `src/routes/+page.svelte`（`<style>` 全面差し替え。マークアップ/bind/handler は不変）
- Modify: `src/lib/prompts/PadEditor.svelte`（`<style>` 全面差し替え＋ Task 5 の新クラス）

**Interfaces:**
- Consumes: なし（CSS のみ）。VJ 窓（`/vj`）は対象外。

**方針（spec §7 更新版）**: パッチコード・インレット/アウトレット端子・格子/ドット・オブジェクトボックス（枠＋端子）は**出さない**。フラットグレー背景（#d4d4d4 前後）＋機能ごとの bgcolor パネル（極薄枠・わずかな角丸）＋整然としたウィジェット（スライダー=accent ティール #3a7d8c、トグル=四角＋X、bang=円、number box=コンパクト、ラベル=小さなコメント文字）。SVG パッドは presentation 上の黒枠ディスプレイ。

- [x] **Step 1: +page.svelte の `<style>` を presentation 風に差し替え**:

```css
  :root { color-scheme: light; }
  /* presentation ボード: フラットで落ち着いたグレー（格子・パッチコード無し） */
  main {
    font-family: Arial, system-ui, -apple-system, sans-serif;
    padding: 18px;
    min-height: 100vh;
    box-sizing: border-box;
    color: #1a1a1a;
    background: #d4d4d4;
  }
  h1 { font-size: 13px; font-weight: 700; color: #333; letter-spacing: 0.04em; margin: 0 0 12px; }
  /* bgcolor パネル（端子・コード無しのフラット区画） */
  fieldset {
    background: #e3e3e3;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 5px;
    margin: 12px 0;
    padding: 10px 14px 12px;
  }
  fieldset > legend {
    color: #444;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0 4px;
  }
  fieldset:not(.panel) { display: flex; gap: 16px; flex-wrap: wrap; }
  label { font-size: 12px; }
  .cfg { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 8px; align-items: center; }
  .cfg label { display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
  .mute { color: #555; font-size: 11px; }
  .row { display: flex; gap: 12px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
  .learn { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
  .learn button { font-size: 11px; }
  .synth { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 11px; margin-top: 6px; }
  /* number box（コンパクトな数値表示） */
  .num {
    width: 60px;
    padding: 3px 5px;
    background: #f6f6f6;
    color: #1a1a1a;
    border: 1px solid #b5b5b5;
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
  }
  select {
    padding: 4px 6px;
    background: #f6f6f6;
    color: #1a1a1a;
    border: 1px solid #b5b5b5;
    border-radius: 3px;
  }
  /* フラットなボタンウィジェット */
  button {
    padding: 5px 12px;
    font-size: 12px;
    background: #f6f6f6;
    color: #1a1a1a;
    border: 1px solid #b5b5b5;
    border-radius: 4px;
    cursor: pointer;
  }
  button:hover { background: #fff; }
  button:active { background: #3a7d8c; border-color: #2c5f6a; color: #fff; }
  button:disabled { opacity: 0.4; cursor: default; }
  button.learning { background: #3a7d8c; border-color: #2c5f6a; color: #fff; }
  /* スライダー: トラック塗り＋ティール（WKWebView/Safari は accent-color でトラック塗りが効く） */
  input[type="range"] { accent-color: #3a7d8c; }
  /* トグル: 四角、ON で X 印 */
  input[type="checkbox"] {
    appearance: none;
    width: 14px;
    height: 14px;
    margin: 0 4px 0 0;
    border: 1px solid #8a8a8a;
    border-radius: 2px;
    background: #f6f6f6;
    cursor: pointer;
    vertical-align: -2px;
  }
  input[type="checkbox"]:checked {
    background: #f6f6f6 url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" stroke="%233a7d8c" stroke-width="2"/></svg>') center / 10px 10px no-repeat;
  }
  input[type="radio"] {
    appearance: none;
    width: 13px;
    height: 13px;
    margin: 0 4px 0 0;
    border: 1px solid #8a8a8a;
    border-radius: 50%;
    background: #f6f6f6;
    cursor: pointer;
    vertical-align: -2px;
  }
  input[type="radio"]:checked { background: radial-gradient(circle, #3a7d8c 0 4px, #f6f6f6 4.5px); }
  .fps { font-variant-numeric: tabular-nums; color: #2c5f6a; font-size: 12px; }
  .src { color: #555; font-size: 11px; }
  .key { font-size: 11px; }
  .key.ok { color: #1e7d3c; }
  .key.ng { color: #b3552a; }
  .err { color: #b3402a; font-size: 12px; }
  .hint { font-size: 11px; color: #666; }
```

- [x] **Step 2: PadEditor.svelte の `<style>` を presentation 風に差し替え**（SVG パッドは黒枠ディスプレイ・端子/コード無し）:

```css
  .pad-editor { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-start; color: #1a1a1a; }
  .pad-col { flex: 0 1 340px; min-width: 260px; }
  /* presentation 上のディスプレイ（黒枠。端子・コード無し） */
  svg {
    width: 100%;
    aspect-ratio: 1 / 1;
    display: block;
    border: 1px solid #333;
    border-radius: 3px;
    touch-action: none;
    cursor: crosshair;
  }
  svg.placing { cursor: copy; }
  .bg { fill: #04090c; }
  .grid { stroke: #0a2a30; stroke-width: 0.2; }
  .pin .sigma {
    fill: rgba(34, 211, 238, 0.04);
    stroke: rgba(34, 211, 238, 0.28);
    stroke-width: 0.25;
    stroke-dasharray: 1.4 1.4;
  }
  .pin .dot { fill: #34d399; stroke: #a7f3d0; stroke-width: 0.3; }
  .pin.selected .dot { fill: #f0c674; stroke: #fff; }
  .pin .label { fill: #a5f3fc; font: 3.2px ui-monospace, monospace; text-anchor: middle; pointer-events: none; }
  .pin .influence { stroke: #22d3ee; stroke-width: 0.35; }
  .cursor rect { fill: rgba(103, 232, 249, 0.25); stroke: #67e8f9; stroke-width: 0.45; }
  .target line { stroke: #557; stroke-width: 0.35; }
  .target.morphing line { stroke: #f0c674; }
  .target text { fill: #778; font: 2.8px ui-monospace, monospace; }
  .under { min-height: 20px; margin-top: 6px; font: 11px ui-monospace, monospace; color: #2c5f6a; }
  .weights .w { margin-right: 10px; }
  .weights b { color: #1e7d3c; }
  .side { flex: 1 1 260px; min-width: 240px; display: flex; flex-direction: column; gap: 10px; font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row.wrap { flex-wrap: wrap; }
  .text {
    flex: 1;
    min-width: 120px;
    padding: 5px 8px;
    background: #f6f6f6;
    color: #1a1a1a;
    border: 1px solid #b5b5b5;
    border-radius: 3px;
  }
  button {
    padding: 5px 12px;
    font-size: 12px;
    background: #f6f6f6;
    color: #1a1a1a;
    border: 1px solid #b5b5b5;
    border-radius: 4px;
    cursor: pointer;
  }
  button:hover { background: #fff; }
  button:active { background: #3a7d8c; border-color: #2c5f6a; color: #fff; }
  button.active { background: #3a7d8c; border-color: #2c5f6a; color: #fff; }
  button.danger { background: #eadad5; border-color: #b3552a; }
  .tchip { display: inline-flex; align-items: center; gap: 3px; }
  /* bang（円ボタン） */
  .tchip .x {
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 50%;
    line-height: 1;
  }
  .tchip.morphing button { border-color: #b3552a; color: #b3552a; }
  label { display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
  input[type="range"] { accent-color: #3a7d8c; }
  input[type="checkbox"] {
    appearance: none;
    width: 14px;
    height: 14px;
    margin: 0 4px 0 0;
    border: 1px solid #8a8a8a;
    border-radius: 2px;
    background: #f6f6f6;
    cursor: pointer;
    flex: none;
  }
  input[type="checkbox"]:checked {
    background: #f6f6f6 url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" stroke="%233a7d8c" stroke-width="2"/></svg>') center / 10px 10px no-repeat;
  }
  /* サブパネル（フラットな bgcolor 区画） */
  .edit, .vjdev {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px;
    background: #dcdcdc;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 4px;
  }
  .boxtitle { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #444; }
  .fxname { min-width: 64px; display: inline-block; }
  .hint { font-size: 11px; color: #666; margin: 0; }
```

- [x] **Step 3: 検証** — `npm run check` 0 errors・`npm run build` 成功。見た目は user の live 確認。

### Task 7: 検証締め＋ HANDOFF 更新

**Files:**
- Modify: `HANDOFF.md`

- [x] **Step 1: 全検証を実測**:

```bash
npm test                                                  # 172 + 新規（8 前後）全緑
npm run check                                             # 0 errors
npm run build                                             # 成功
cargo test --manifest-path src-tauri/Cargo.toml --lib     # 6 緑
cargo clippy --manifest-path src-tauri/Cargo.toml --lib   # clean
```

- [x] **Step 2: HANDOFF.md 更新** — 「現在地」に M8 完了を反映し、「M8 実装完了メモ（2026-07-24）」セクション（構成・確認済み export・調整ポイント・live 未確認項目）を追記。

## Self-Review

- **Spec coverage**: §2 carry → Task 1。§3.1 オブジェクト 5 種 → Task 3。§3.2 ポストエフェクト 5 種＋scene.ts 配線＋resize → Task 4。§4 control UI → Task 5。§5 テスト → Task 1〜4 内。§7 Max/MSP 風 → Task 6。§8 初版スコープ（プレースホルダ的でも操作できる土台優先）→ 全タスク。
- **Placeholder scan**: なし（全ステップ実コード）。
- **Type consistency**: `VjObjectKey`/`VjEffectKey` は Task 1 が単一定義、Task 2〜5 が import。`PostFx.setEffect(name: VjEffectKey, ...)` を Task 4 Step 5 の scene.ts が使用。`objectTargets`/`effectTargets` の戻り `Record<Key, number>` 一致。
