# Lyria VJ — M8: 展開（トグル可能オブジェクト＋ポストエフェクト）設計

- 日付: 2026-07-24
- 位置づけ: 単一 PromptSpace シーンに「展開」を付ける。表示/非表示できるオブジェクト群と、グリッチ/画面分割等のポストエフェクトを用意し、control 窓から ON/OFF・強度を操作。
- ステータス: 設計（brainstorming 合意済みの延長。user 指示 2026-07-24）。git 未初期化のまま。**実装は Fable モデル**。

## 1. ゴール

同一シーンのまま、VJ が時間的な「展開」を作れるようにする:
- **表示/非表示できるオブジェクトをいくつか**（星雲、地平線/ワイヤードーム、スキャン、中央パルス、星座線 など）。
- **ポストエフェクトをいくつか**（グリッチ、画面分割、RGB ずらし、ブルーム、ピクセル/走査線 など）を ON/OFF・強度で。
- すべて control 窓から操作 → prompt_space チャネルで VJ へ（**Rust 変更なし**）→ localStorage 永続。切替は滑らかに。

## 2. 状態モデル（carry）

`PromptSpaceState`（`src/lib/prompts/promptSpace.ts`）に **view 設定**を追加（既存 cameraEnergy/floorReactive と同じ carry 経路＝prompt_space チャネル、no-Rust）:

```ts
// 追加（すべて任意・省略時デフォルト）
vjObjects?: { nebula?: boolean; horizon?: boolean; scan?: boolean; corePulse?: boolean; constellation?: boolean };
vjEffects?: { glitch?: number; split?: number; rgbShift?: number; bloom?: number; scanline?: number }; // 各 0..1
```

- `clampPromptSpaceState` で防御整形（bool 化 / 0..1 clamp、未指定はデフォルト）。`defaultPromptSpaceState` に既定（全 object false、全 effect 0）。
- 純粋ヘルパ `setVjObject(s, key, on)` / `setVjEffect(s, key, amount)`（immutable）＋ Vitest。
- persistence round-trip テストに新フィールドを反映。

## 3. VJ 側

### 3.1 トグル・オブジェクト（`scenes/promptSpace.ts` に追加。visibility/opacity を滑らかに）

各オブジェクトは常時 init で構築し、**表示強度 uniform（0..1）を easeAlpha で目標へ補間**（突然出/消しない）。案:
- **nebula**: 大きく柔らかい加算スプライト群（少数・大サイズ）で霧/星雲。level で明滅。
- **horizon**: 地平線リング or ワイヤードーム（LineSegments）。空間の広がり。
- **scan**: 上下 or 放射に走るスキャン面/線（time で移動、onset で加速）。
- **corePulse**: 中央の大きなビートパルス（burst/level で拡大縮小・発光）。
- **constellation**: カーソル/アクティブピン近傍の星を結ぶ線（動的）。
- 各 `uObjX`(0..1) を opacity/scale に乗算。OFF→0 で不可視。

### 3.2 ポストエフェクト（`three/webgpu` PostProcessing）

- `src/lib/vj/post.ts`（新規）: `createPostFx(renderer, scene, camera)` を用意。`PostProcessing` ＋ `pass(scene, camera)` を起点に、TSL で各エフェクトを重ねた `outputNode` を構築。各エフェクトは uniform(0..1) で強度制御（0=透過）。`setEffect(name, amount)` / `renderAsync()` / `setSize()` / `dispose()`。
- エフェクト（**実 export を three 0.185.1 で確認してから実装**。既製ノードが無ければ TSL で自作 or その項目のみ skip して log）:
  - **glitch**: ブロック状 UV ずらし＋RGB 分離＋ノイズ（onset/level 連動可）。
  - **split**: 画面分割/ミラー（2×2 タイル or 左右ミラー、kaleidoscope 風）。
  - **rgbShift**: 色収差（UV を R/G/B で微小オフセット）。
  - **bloom**: 既製 `bloom`（`three/addons` の TSL bloom）が使えれば採用、無ければ簡易ブライトパス＋ブラー。
  - **scanline**: 走査線＋わずかな歪み。
- `scene.ts`: レンダを PostProcessing 経由に。全エフェクト 0（透過）時のオーバーヘッドは許容（または amount 合計 0 の間は `renderer.renderAsync` に自動フォールバックでも可）。resize は post にも伝える。**WebGPU/TSL 構築が throw しないこと**をスモークで担保。
- 強度は control から carry（§2 vjEffects）→ VJ で uniform に滑らかに反映。

## 4. control UI（PadEditor もしくは +page の「VJ 展開」パネル）

- オブジェクト: チェックボックス群（nebula/horizon/scan/corePulse/constellation）。
- エフェクト: スライダー群（glitch/split/rgbShift/bloom/scanline、0..1）。
- 変更 → `commit` → prompt_space 送信＋localStorage（PadEditor の既存経路を流用）。

## 5. テスト

- 純粋: `setVjObject`/`setVjEffect`（immutable・clamp）、`clampPromptSpaceState`（新フィールド）、persistence round-trip。
- スモーク: promptSpace init に追加オブジェクトが乗っても throw しない。`createPostFx` の構築が（GPU 無し環境で可能な範囲で）throw しない or scene smoke でカバー。※PostProcessing は GPU 依存で単体不可なら build で担保し live 確認に委ねる（その旨明記）。
- live のみ: 各オブジェクト/エフェクトの見た目・強度、WebGPU PostProcessing の動作、パフォーマンス。

## 6. 制約

- three **0.185.1**。`PostProcessing`/`pass`/エフェクトノードの**実 export を確認してから使う**（推測禁止）。使えない項目は TSL 自作 or skip＋log。
- **Rust 変更なし**（carry は prompt_space チャネル）。
- ベースライン緑を割らない: vitest 172・svelte-check 0・build 成功・cargo test 6・clippy clean。
- 切替は easeAlpha で滑らかに（カクつき/突然の出現消失なし）。
- 秘密情報は扱わない。

## 7. コントロール画面の Max/MSP 風デザイン（user 指示 2026-07-24・**Presentation モード風**）

control 窓（`src/routes/+page.svelte` ＋ `src/lib/prompts/PadEditor.svelte`）を Max/MSP の **Presentation（performance）モード**風に**全面リスタイル**。CSS 中心（構造/挙動は変えない）。VJ 窓（黒）は対象外。

**重要（訂正）**: パッチャー/エディットモードの見た目は**望ましくない**。以下は**出さない**:
- パッチコード（オブジェクト間を結ぶ線）
- インレット/アウトレットの黒ノブ
- エディット感のあるオブジェクトボックス（枠＋端子）や不要オブジェクトの露出

**目指すのは Presentation モードのクリーンな UI**:
- 選ばれた UI ウィジェットだけが**整然と並ぶ**（スライダー / ダイヤル / ナンバーボックス / トグル / ボタン / コメント）。配線や内部オブジェクトは見えない。
- **背景**: フラットで落ち着いたグレー（例 `#d9d9d9`〜`#cfcfcf`）。格子/ドットは無し（またはごく控えめ）。パッチコード無し。
- **パネル**: 機能ごとに**フラットな背景色区画（bgcolor パネル）**で軽くグルーピング（Max の presentation パネル）。枠は極薄 or 無し、角丸わずか。端子・コードは付けない。
- **ウィジェット**: Max presentation 風の見た目に統一。スライダーはトラックに塗り（`accent-color` を Max 調のティール/グレー `#3a7d8c` 等）、トグルは四角、bang は円、number box はコンパクトな数値表示。ラベルは小さなコメント文字。
- **タイポ**: クリーンなサンセリフ（system-ui / Arial 系）、小さめ、黒〜濃グレー文字。
- **レイアウト**: presentation ボードのように整列（グリッド/フレックス）。既存機能（音源選択・prompts パッド・config・FX・MIDI・VJ 展開）を整った widget 群として配置。プロンプト空間パッド（SVG）は presentation 上の 1 ディスプレイとして馴染ませる（黒枠ディスプレイ可、ただし端子/コードは付けない）。
- 可読性・操作性維持（見た目のみ。bind/handler は壊さない）。§4 の VJ 展開パネルもこの presentation 風で。

## 8. スコープ / 段階

- 初版: §3 オブジェクト5・エフェクト5を「用意」（プレースホルダ的でも良いが build/smoke 緑・live で調整可能な状態）＋ §7 の Max/MSP 風リスタイル。過度な作り込みより「操作できる土台」を優先。
- 将来: エフェクトの自動シーケンス（時間/onset で自動展開）、プリセット。
