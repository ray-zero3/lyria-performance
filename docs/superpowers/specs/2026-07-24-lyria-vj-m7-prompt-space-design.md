# Lyria VJ — M7: プロンプト空間（音像モーフ・コントローラ＋3D VJ＋生データパネル）設計

- 日付: 2026-07-24
- 位置づけ: Lyria の「複数重み付きプロンプト＋live 操作」という強みを主役にした新機能。M6 の VJ 基盤（sceneManager/scenes/dataLayer）に追加。
- ステータス: 設計（brainstorming 合意済み 2026-07-24）。git 未初期化のまま（コミットしない合意）。**実装は Fable モデルで行う**（user 指示）。

## 1. ゴール / コンセプト

- **コントローラ**: 2D パッドに「prompt を書いたピン」を置き、**カーソル（=音像位置）**を動かすと近傍ピンの重みがガウシアン減衰でブレンドされ、`setWeightedPrompts` に反映（live 音像モーフ）。**ターゲット（カーソル位置スナップショット）を保存**し、指定時間で自動補間モーフも可能。
- **VJ**: 同じ配置を **3D 空間**に立ち上げ、ピンを配置。ピンに内包されたデータ（prompt テキスト・現在の重み・音響寄与）を「解析されるような演出」で可視化。カーソルの影響（ピン→カーソルの流れ/線）を見せる。
- **VJ 右側**: 実際に送受信・処理されているデータを**生の文字列**として表示（現在状態スナップショット＋時系列ストリームログ）。
- **美観**: 黒ベース・データ感（モノスペース、シアン/緑/白、細線、グリッド、ワイヤーフレーム、グロー控えめ）。

Lyria は複数 weighted prompts と live `setWeightedPrompts` に既に対応済み（`driver.setPrompts(WeightedPrompt[])`）。本機能はその強みを直接活かす。

## 2. コンセプトモデル（純粋ロジック）

- `Pin = { id: string; text: string; x: number; y: number; radius: number; color?: string }`（x,y は 0..1 正規化パッド座標）。
- `Cursor = { x: number; y: number }`。
- `Target = { id: string; name: string; x: number; y: number }`（カーソル位置スナップショット）。
- `PromptSpaceState = { pins: Pin[]; cursor: Cursor; targets: Target[] }`。
- **重み計算** `computeWeights(pins, cursor): WeightedPrompt[]`（純粋）:
  - 各ピン raw_i = exp(-d² / (2·radius_i²))（d = ピン↔カーソル距離）。
  - **sum 正規化**（Σ=1 のブレンド）。near-zero（< 閾値 0.02）は除外。**上位 K=6 件**に制限（Lyria 実用上限）。
  - 空テキストは除外。結果を `driver.setPrompts` へ（カーソル移動でスロットル ~120ms）。
- **モーフ** `morphStep(cursor, target, progress): Cursor`（純粋）: 保存ターゲットへ progress 0..1 で線形/ease 補間。UI 側は指定 duration で progress を進めて自動モーフ。
- ピン CRUD は immutable ヘルパ（add/move/remove/updateText/updateRadius）。

## 3. コントローラ UI（`/` 2D パッド）

- 新コンポーネント `src/lib/prompts/PadEditor.svelte`（SVG or canvas）:
  - パッド上にピン（●＋テキストラベル）とカーソル（◇）。ピンをドラッグ移動、クリックで選択。
  - 「+ピン」: テキスト入力＋クリック配置。ピンのテキスト/半径編集、削除。
  - カーソルをドラッグ=live モーフ。ターゲット保存（現カーソル位置に名前）、ターゲット選択で自動モーフ（duration スライダー）。
  - カーソル移動/ピン変更のたびに `computeWeights` → `driver.setPrompts`（スロットル）＋ `transport.pushPromptSpace(state)`。
- 既存の**単一 promptText/promptWeight 入力はこのパッドに置換**。config スライダー・FX・rotation・MIDI・音源選択は現状維持（壊さない）。
- パッド状態は localStorage 永続（`lyria-vj-prompt-space`）。

## 4. トランスポート（プロンプト空間の VJ 中継）

既存の frame/event と同形の**不透明リレー・チャネルを1つ追加**（HubState は変更しない）:
- `bus.ts` `TelemetryTransport` に `pushPromptSpace(space)` / `onPromptSpace(cb)` 追加。
- `browserTransport`: BroadcastChannel に新メッセージ種別 `promptSpace`。
- `tauriTransport`: `invoke("push_prompt_space", { space })` ＋ `listen("prompt_space")`。
- **Rust**: `src-tauri/src/hub/relay.rs` に `push_prompt_space`（`push_event` を模した不透明中継 `emit_to("vj","prompt_space",..)`）を追加、`lib.rs` の invoke_handler に登録。**この Rust 変更は本機能で想定内**（小・一貫）。
- 後発で開いた VJ 窓も同期できるよう、コントローラは prompt-space を**変更時＋~2Hz ハートビート**で emit。VJ は **last-known** を保持。

## 5. VJ: PromptSpace シーン（3D・TSL）

- 新シーン `src/lib/vj/scenes/promptSpace.ts`（`SceneImpl`）を sceneManager に登録し、**既定（開始）シーン**にする。既存4シーンは切替で残す。
- 描画:
  - ピン = 3D ノード（パッド x,y → 3D の x,z 平面、y は重みで浮上）。グロー球＋ビルボードのテキストラベル（prompt）。
  - ピンの内包データ可視化: 重みに比例した粒子がノード周囲を周回/放射。active（高重み）ピンは onset/spectrum で脈動し「解析中」風のスキャンリング/データグリフを出す。
  - カーソル = 際立つマーカー。カーソル→各ピンへ太さ=重みの線/流れ。粒子が active ピンからカーソル/中心へ流れる。
  - onset バースト・spectrum 構造は空間全体にも作用（M6 の visualMapping を流用）。
  - 黒背景・グリッド床・細線・シアン/緑/白。
- データ源: `store` の last-known `promptSpace`（§4）＋ frame（onset/spectrum/level）＋ HubState（weights と一致確認用）。

## 6. VJ 右側 生データパネル

- `src/lib/vj/dataPanel.ts`（DOM オーバーレイ、右 ~30% 幅、モノスペース、黒/シアン/緑）:
  - **上部スナップショット（現在状態）**: 現 weighted prompts（テキスト＋重みバー）、config（bpm/guidance/density/brightness/temperature）、session state、rotation/chaos。
  - **下部ストリームログ**: SENT（setWeightedPrompts / setMusicGenerationConfig の JSON）、RECV（chunk 数、session/rotate events）、ANALYSIS（level/onset のティック）を**タイムスタンプ付き生ログ**で追記（リング上限 ~200 行、auto-scroll）。event リング＋frame から生成。
  - 行整形 `formatLogLine(event|frame|state) → string` は**純粋関数**で切り出しテスト。テキスト更新は ~10Hz にスロットル（DOM 負荷）。

## 7. MIDI（Lyria の強みを操作に）

- `ContinuousTarget` に `cursorX` / `cursorY`（範囲 [0,1]）を追加（CC でカーソル操作＝MIDI 音像モーフ）。`RANGES` 追記。
- `ActionTarget` に `morph_next`（次ターゲットへ自動モーフ）を追加。`applyAction`＋UI ボタン。
- `applyContinuous` に cursorX/cursorY 分岐（カーソル更新→重み再計算→送信＋pushPromptSpace）。

## 8. テスト計画

**純粋・単体（Vitest）**:
- `promptSpace.computeWeights`: 単一ピン上でそのピア重み最大、2ピン中間で均等、遠方 near-zero 除外、上位 K 制限、Σ正規化、空テキスト除外。
- `promptSpace.morphStep`: progress 0→cursor 据置、1→target 一致、中間で補間。
- ピン CRUD immutable ヘルパ（元を変更しない）。
- `dataPanel.formatLogLine`: 代表イベント（prompt_set/config_set/chunk/session/rotate、control、frame）→ 期待文字列。
- `sceneManager`: PromptSpace を含む一覧・既定シーン・切替が壊れない。

**live のみ（user 確認）**: パッド操作の音像モーフ体感、3D プロンプト空間の見た目、右パネルの可読性、MIDI カーソル、第2ディスプレイ。WebGPU/AudioContext は非フォーカスで停止のため私・サブエージェント環境では目視不可。

## 9. スコープ / 段階

- **追加機能**（M6 を壊さない）: PromptSpace シーンを既定に、既存4シーンは切替で残す。単一 prompt 入力はパッドに置換。
- 初版は 2D パッド→3D VJ（合意）。3D 直接配置は将来。
- ターゲット自動モーフは単一ターゲットへの補間から（複数ターゲットのシーケンス/パスは将来）。

## 10. 制約 / リスク

- three 0.185.1 の TSL/WebGPU は M6 同様、実 export 確認の上で実装（推測禁止）。ビルド＋純ロジックで健全性担保、見た目は live。
- Rust 変更は §4 の `push_prompt_space` のみ（想定内・push_event と同形）。他に Rust 変更が要る場合は理由を明記。
- 送信 prompt の生ログに API キー等の秘密は含めない（prompts/config のみ）。
- ベースライン緑（vitest 110・svelte-check 0・build・cargo test 6・clippy）を割らない。

## 11. 想定ファイル

- 新規: `src/lib/prompts/promptSpace.ts`(+test) / `PadEditor.svelte`、`src/lib/vj/scenes/promptSpace.ts`、`src/lib/vj/dataPanel.ts`(+ formatLogLine test)。
- 変更: `bus.ts`/`browserTransport.ts`/`tauriTransport.ts`/`contract.ts`（PromptSpace 型・チャネル）、`src-tauri/src/hub/relay.rs`＋`lib.rs`（push_prompt_space）、`src/lib/vj/store.ts`（last-known promptSpace）、`src/lib/vj/sceneManager.ts`＋`scene.ts`（PromptSpace 登録・既定・右パネル配線）、`src/routes/+page.svelte`（パッド統合・cursor MIDI・morph_next）、`src/lib/midi/types.ts`/`mapping.ts`（cursorX/Y・morph_next）、`src/routes/vj/+page.svelte`（右パネル領域）。
