# M7 プロンプト空間（音像モーフ・コントローラ＋3D VJ＋生データパネル）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 本プロジェクトは自動進行合意により同一セッションで inline 実行する（サブエージェント多重起動はコスト規約で不可）。

**Goal:** 2D パッド上のプロンプトピンとカーソルで Lyria の複数重み付きプロンプトを live モーフし、同じ空間を VJ 窓の 3D 既定シーン＋右側生データパネルとして可視化する。

**Architecture:** 純粋ロジック `promptSpace.ts`（ガウシアン重み・モーフ・immutable CRUD）→ コントローラ `PadEditor.svelte`（SVG パッド、driver.setPrompts＋pushPromptSpace）→ 不透明リレー・チャネル `prompt_space`（bus/browser/tauri/Rust relay）→ VJ 側 `store`（last-known）→ 既定シーン `scenes/promptSpace.ts`（TSL Sprite 粒子）＋ `dataPanel.ts`（右 30% 生ログ、整形は純粋関数）。

**Tech Stack:** Tauri v2 / SvelteKit (Svelte 5 runes) / Vite / three 0.185.1（`three/webgpu`＋`three/tsl`、export 実在確認済み）/ Vitest / Rust (tauri Emitter)。

## Global Constraints

- **git コミットはしない**（プロジェクト合意。各タスク末尾は検証ステップで締める）。
- immutability 厳守・小さいファイル（200-400 行目安）。
- 純粋ロジック（promptSpace / dataPanelFormat）は **TDD（RED→GREEN）**。TSL/Svelte は build＋svelte-check＋smoke test で担保、見た目は user live 確認。
- ベースライン緑を割らない: vitest 110（新規分のみ増加）/ svelte-check 0 errors / `npm run build` 成功 / cargo test 6 / clippy clean。
- Rust 変更は `push_prompt_space`（relay.rs＋lib.rs 登録）のみ。
- 生ログに API キー等の秘密を出さない（prompts/config/解析値のみ）。
- three の export は実在確認済みのもののみ使用: `three/webgpu`: CanvasTexture / SpriteNodeMaterial / LineBasicMaterial / LineSegments / BufferGeometry / Float32BufferAttribute / GridHelper / AdditiveBlending / Color / Group / Sprite。`three/tsl`: texture / uniform / uniformArray / instanceIndex / float / vec2 / vec3 / hash / mix / smoothstep / length / uv / floor / int / abs / fract / sin / cos / PI2 / mx_noise_float / normalize。
- vitest は `environment: "node"`（DOM 依存コードはテスト対象から分離 or ガード）。
- Svelte 5 `$state` プロキシは postMessage/structuredClone 不可 → transport へ渡す境界で必ず `$state.snapshot()`。

## 設計上の決定（spec からの具体化）

- **型の置き場所**: spec §11 通り `Pin/Cursor/Target/PromptSpaceState` は `src/lib/prompts/promptSpace.ts` に定義（`contract.ts` は変更しない。transport は `$lib/prompts/promptSpace` から type import。モジュール循環なし: promptSpace→contract、bus→promptSpace）。
- **computeWeights の順序**: 空テキスト除外 → raw=exp(-d²/(2r²)) → Σ正規化 → 閾値 0.02 未満除外 → 上位 K=6 → 再正規化（最終 Σ=1）。全滅時（アンダーフロー/全ピン閾値未満）は最近傍ピン weight=1 にフォールバック（無音化防止）。
- **promptWeight MIDI ターゲットは削除**（単一 prompt 入力のパッド置換に伴い）。stale な保存マッピングは `isContinuous` 判定から漏れて action 分岐 no-op になるため安全。
- **VJ シーンのピン重み**: テキスト照合ではなく純粋関数 `normalizedPinWeights(pins, cursor): number[]`（ピン index 対応、閾値/topK 前の正規化値）をシーンが直接使う。
- **既定シーン**: `scenes/index.ts` の `createSceneBundle()` が `[promptSpace, vortex, radialSpectrum, terrain, swarm]` を返し index 0 が既定（sceneManager は先頭が current）。
- **ラベル**: CanvasTexture＋SpriteNodeMaterial（`colorNode=texture(tex)`、`opacityNode=texture(tex).a`）。`typeof document === "undefined"` ではスキップ（node の smoke test / SSR 安全）。
- **データパネルの新イベント検出**: store の event リングはオブジェクト参照を保持するため、最後に見た event の参照位置から後を追記（見つからなければ全件＝起動直後の履歴表示）。

---

### Task 1: 純粋ロジック promptSpace.ts（TDD）

**Files:**
- Create: `src/lib/prompts/promptSpace.ts`
- Test: `src/lib/prompts/promptSpace.test.ts`

**Interfaces (Produces):**
```ts
export interface Pin { id: string; text: string; x: number; y: number; radius: number; color?: string }
export interface Cursor { x: number; y: number }
export interface Target { id: string; name: string; x: number; y: number }
export interface PromptSpaceState { pins: Pin[]; cursor: Cursor; targets: Target[] }
export const WEIGHT_THRESHOLD = 0.02; export const MAX_ACTIVE_PROMPTS = 6;
export const DEFAULT_PIN_RADIUS = 0.28; export const MIN_PIN_RADIUS = 0.05; export const MAX_PIN_RADIUS = 1;
export function computeWeights(pins: readonly Pin[], cursor: Cursor): WeightedPrompt[]
export function normalizedPinWeights(pins: readonly Pin[], cursor: Cursor): number[]
export function morphStep(cursor: Cursor, target: {x:number;y:number}, progress: number): Cursor
export function easeInOutCubic(t: number): number
export function makeId(prefix: string): string
export function defaultPromptSpaceState(): PromptSpaceState  // スターター4ピン＋中央カーソル
export function clampPromptSpaceState(input: unknown): PromptSpaceState  // 境界の防御的整形
// immutable CRUD（元 state を変更しない）
export function addPin(s, pin): PromptSpaceState
export function movePin(s, id, x, y): PromptSpaceState
export function removePin(s, id): PromptSpaceState
export function updatePinText(s, id, text): PromptSpaceState
export function updatePinRadius(s, id, radius): PromptSpaceState
export function moveCursor(s, x, y): PromptSpaceState
export function addTarget(s, target): PromptSpaceState
export function removeTarget(s, id): PromptSpaceState
```

- [x] **Step 1: 失敗するテストを書く**（computeWeights: 単一ピン上=weight1 / 2ピン中間=均等 / 遠方閾値除外 / 上位K制限 / Σ=1 / 空テキスト除外 / ピン無し=[] / 全滅フォールバック、normalizedPinWeights、morphStep 0/1/中間/クランプ、easeInOutCubic、CRUD immutability、clamp/default）
- [x] **Step 2: `npx vitest run src/lib/prompts` → FAIL（モジュール未存在）を確認**
- [x] **Step 3: promptSpace.ts を実装**
- [x] **Step 4: `npx vitest run src/lib/prompts` → PASS**
- [x] **Step 5: `npm test` 全緑（既存 110 を割らない）**

### Task 2: localStorage 永続 persistence.ts（TDD・Storage 注入）

**Files:**
- Create: `src/lib/prompts/persistence.ts`
- Test: `src/lib/prompts/persistence.test.ts`

**Interfaces (Produces):**
```ts
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
export const PROMPT_SPACE_KEY = "lyria-vj-prompt-space";
export function loadPromptSpace(storage?: StorageLike | null): PromptSpaceState // 無し/破損→default、あれば clamp
export function savePromptSpace(state: PromptSpaceState, storage?: StorageLike | null): void // 失敗は握りつぶす
```
既定 storage は `globalThis.localStorage`（node では undefined → default 返却/保存スキップ）。

- [x] Step 1: 失敗するテスト（fake Storage で round-trip / 破損 JSON→default / storage 無し→default）
- [x] Step 2: RED 確認 → Step 3: 実装 → Step 4: GREEN → Step 5: `npm test` 全緑

### Task 3: トランスポート prompt_space チャネル（TS＋Rust）

**Files:**
- Modify: `src/lib/telemetry/bus.ts`（`pushPromptSpace`/`onPromptSpace` を I/F 追加）
- Modify: `src/lib/telemetry/browserTransport.ts`（Msg に `{t:"promptSpace"; space}` 追加）
- Modify: `src/lib/telemetry/tauriTransport.ts`（`invoke("push_prompt_space",{space})`＋`listen("prompt_space")`）
- Modify: `src-tauri/src/hub/relay.rs`（`push_prompt_space` = `emit_to("vj","prompt_space", space)` 不透明中継）
- Modify: `src-tauri/src/lib.rs`（invoke_handler へ登録）
- Test: `src/lib/telemetry/browserTransport.test.ts` に round-trip テスト追加

**Interfaces (Produces):** `TelemetryTransport.pushPromptSpace(space: PromptSpaceState): void` / `onPromptSpace(cb: (s: PromptSpaceState) => void): void`

- [x] Step 1: browserTransport.test.ts に「control→vj で promptSpace が届く」テスト追加 → RED
- [x] Step 2: bus/browser/tauri を実装 → GREEN
- [x] Step 3: relay.rs に push_frame/push_event と同形の `push_prompt_space` 追加＋lib.rs 登録
- [x] Step 4: `cargo test --lib`（6 維持）＋ `cargo clippy --lib` clean ＋ `npm test` 全緑

### Task 4: VJ store に last-known promptSpace（TDD）

**Files:**
- Modify: `src/lib/vj/store.ts`
- Test: `src/lib/vj/store.test.ts` に追記

**Interfaces (Produces):** `VjStore.applyPromptSpace(input: unknown): void`（clampPromptSpaceState で防御）、`VjSnapshot.promptSpace: PromptSpaceState | null`（未受信は null）

- [x] Step 1: テスト追加（初期 null / 適用で保持 / 不正入力でも throw せず整形保持）→ RED
- [x] Step 2: 実装 → GREEN → `npm test` 全緑

### Task 5: MIDI cursorX/cursorY・morph_next（promptWeight 削除）

**Files:**
- Modify: `src/lib/midi/types.ts`（ContinuousTarget: `cursorX`/`cursorY` 追加・`promptWeight` 削除、ActionTarget: `morph_next` 追加、配列同期）
- Modify: `src/lib/midi/mapping.ts`（RANGES: cursorX/cursorY [0,1]、promptWeight 削除）
- Test: `src/lib/midi/mapping.test.ts` に scaleCc(cursorX) と isContinuous(cursorX)/isContinuous(morph_next)=false を追加

- [x] Step 1: テスト追加 → RED → Step 2: 実装 → GREEN → `npm test` 全緑

### Task 6: 生ログ整形 dataPanelFormat.ts（TDD・純粋）

**Files:**
- Create: `src/lib/vj/dataPanelFormat.ts`
- Test: `src/lib/vj/dataPanelFormat.test.ts`

**Interfaces (Produces):**
```ts
export const LOG_PAYLOAD_MAX = 160;
export function fmtClock(tMs: number): string          // "HH:MM:SS.mmm"（ローカル時刻）
export function truncateJson(v: unknown, max?): string  // JSON 文字列化＋max 超は "…" で切る
export function weightBar(w: number, width?): string    // "███░░░░░░░" clamp01
export function formatLogLine(e: TelemetryEvent): string
// api prompt_set/config_set → "SENT"、chunk/session/rotate → "RECV"、control → "CTRL"
export function formatAnalysisLine(f: TelemetryFrame): string  // "ANLY level=.62 onset=.10 low/mid/high"
export function snapshotLines(state: HubState, space: PromptSpaceState | null): string[]
```

- [x] Step 1: 代表イベント（prompt_set/config_set/chunk/session/rotate/control/frame）→期待文字列のテスト（時計部分は regex）＋ truncateJson/weightBar/snapshotLines → RED
- [x] Step 2: 実装 → GREEN → `npm test` 全緑

### Task 7: 右生データパネル dataPanel.ts＋vj ページレイアウト

**Files:**
- Create: `src/lib/vj/dataPanel.ts`（DOM。リング 200 行、描画 ~10Hz スロットル、ANALYSIS ティック 500ms、auto-scroll）
- Modify: `src/routes/vj/+page.svelte`（flex レイアウト: 左 stage（canvas+overlay）/右 panel 30%、`onPromptSpace`→store 配線）
- Modify: `src/lib/vj/scene.ts`（`startScene(holder, overlay, panel, store)` に拡張、loop 内で `dataPanel.update(snap, nowMs)`）

**Interfaces (Produces):** `createDataPanel(root: HTMLElement): { update(snap: VjSnapshot, nowMs: number): void; dispose(): void }`

- [x] Step 1: dataPanel.ts 実装（上=snapshotLines、下=ログリング。黒/モノスペース/シアン緑）
- [x] Step 2: vj/+page.svelte と scene.ts を配線
- [x] Step 3: `npm run check` 0 errors ＋ `npm run build` 成功

### Task 8: VJ 3D シーン scenes/promptSpace.ts＋scenes/index.ts（既定シーン化）

**Files:**
- Create: `src/lib/vj/scenes/promptSpace.ts`（`PromptSpaceSceneImpl extends SceneImpl` に `setPromptSpace(space | null)`）
- Create: `src/lib/vj/scenes/index.ts`（`createSceneBundle(): { impls: SceneImpl[]; promptSpace: PromptSpaceSceneImpl }`、先頭= promptSpace）
- Modify: `src/lib/vj/scene.ts`（bundle 使用・loop 冒頭で `promptSpace.setPromptSpace(snap.promptSpace)`）
- Test: `src/lib/vj/scenes/scenes.test.ts`（promptSpace の smoke: init/setPromptSpace/update/dissolve/flash/dispose が throw しない）、`src/lib/vj/scenes/index.test.ts`（一覧5件・既定= promptSpace・next() 巡回）

**描画構成（TSL・M6 手法）:**
- 定数: `MAX_VIS_PINS=12` / `ORBIT_COUNT=3600`（ピン周回粒子）/ `FLOW_COUNT=900`（ピン→カーソル流）/ `PAD_SCALE=3.2`。
- uniforms: 共通束＋ `uPinPos: uniformArray<vec3>[12]`＋`uPinWeight: uniformArray<float>[12]`＋`uPinActive: uniformArray<float>[12]`＋`uCursor: uniform(vec3)`。
- パッド→世界: X=(x−0.5)·PAD_SCALE、Z=(y−0.5)·PAD_SCALE、ピン Y=weight·1.1+0.05（重みで浮上）。
- 周回粒子: 担当ピン k=floor(hash·12)、軌道半径=0.12+weight·0.5、spectrum bin 脈動＋burst·weight で「解析中」、opacity ∝ active·weight。シアン/緑ミックス＋白 flash。
- 流れ粒子: t=fract(hash+time·(0.3+weight)) で pinPos→cursor を移動、weight ∝ 輝度。
- 影響線: `LineSegments`＋`LineBasicMaterial({vertexColors, additive})`、JS で毎フレーム 12 本の座標/色（輝度=weight）更新。
- カーソル: ダイヤ形 Sprite（uv マンハッタン距離 smoothstep）。グリッド: `GridHelper`。
- ラベル: CanvasTexture Sprite（document ガード、テキスト変更時のみ再描画、Map<pinId> 管理）。

- [x] Step 1: scenes.test.ts へ promptSpace smoke 追加＋index.test.ts 作成 → RED
- [x] Step 2: scenes/promptSpace.ts と scenes/index.ts 実装、scene.ts 配線 → GREEN
- [x] Step 3: `npm test` 全緑＋`npm run check`＋`npm run build`

### Task 9: PadEditor.svelte＋コントローラ統合

**Files:**
- Create: `src/lib/prompts/PadEditor.svelte`
- Modify: `src/routes/+page.svelte`（単一 prompt 入力を撤去しパッドへ置換、cursorX/cursorY/morph_next 分岐、morph ボタン）

**PadEditor 仕様:**
- Props: `onWeights(w: WeightedPrompt[])`（~120ms トレーリング・スロットル）/ `onSpace(s: PromptSpaceState)`（変更時スロットル送信＋500ms ハートビート）。
- インスタンスメソッド（bind:this 経由）: `setCursorNorm(x: number | null, y: number | null)` / `morphNextTarget()`。
- SVG viewBox 0..100。ピン=●＋1σ 円＋ラベル、カーソル=◇。pointer capture でピン/カーソルドラッグ。「+ピン」=テキスト入力＋クリック配置。選択ピンの編集（テキスト/半径/削除）。ターゲット保存/選択で自動モーフ（duration スライダー、easeInOutCubic、rAF）。
- 永続: 変更のたび `savePromptSpace($state.snapshot(space))`（500ms スロットル）。
- 境界: transport/driver へ渡す値は `$state.snapshot()` 経由。weights が空のときは setPrompts しない。
- `+page.svelte`: PadEditor は常時表示（音源不問。非 Lyria では setPrompts が no-op）。`latestWeights` を保持し start() の初期 prompts に使用。applyContinuous に cursorX/cursorY、applyAction に morph_next。

- [x] Step 1: PadEditor.svelte 実装
- [x] Step 2: +page.svelte 統合（promptText/promptWeight 撤去）
- [x] Step 3: `npm run check` 0 errors＋`npm run build` 成功＋`npm test` 全緑

### Task 10: 締めの全体検証＋HANDOFF 更新

- [x] `npm test`（全緑・件数記録）
- [x] `npm run check`（0 errors）
- [x] `npm run build`（成功）
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib`（6）
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib`（clean）
- [x] `HANDOFF.md` に「M7 実装完了メモ（2026-07-24）」追記＋「現在地」更新

## Self-Review

- spec §2（純粋ロジック）→ Task 1、§3（パッド UI/置換/永続）→ Task 2/9、§4（チャネル＋Rust＋ハートビート＋last-known）→ Task 3/4/9、§5（3D 既定シーン）→ Task 8、§6（右パネル＋formatLogLine 純粋）→ Task 6/7、§7（MIDI）→ Task 5/9、§8（テスト計画）→ 各タスクの test、§9/§10（スコープ/制約）→ Global Constraints。ギャップなし。
- contract.ts 非変更は spec §11 との差分（型は promptSpace.ts に一本化）— 設計上の決定に明記済み。
- プレースホルダなし・型名の整合（PromptSpaceState / PromptSpaceSceneImpl / setCursorNorm / morphNextTarget）確認済み。
